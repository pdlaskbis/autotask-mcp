// Autotask query-filter operator tests.
//
// Autotask DISCARDS a filter whose operator it does not recognize rather than
// rejecting the query. A dropped condition never surfaces an error -- it just
// widens the result set, or empties it when nothing valid is left. That makes
// a wrong operator invisible in exactly the way a wrong field name was
// invisible on write (see tests/write-field-names.test.ts): the call succeeds
// and the answer is quietly wrong.
//
// Four such filters were live, each verified against the real API before being
// changed here:
//
//   {op:'ne',        field:'status'}                  -> 'noteq'
//   {op:'isnotnull', field:'billingApprovalDateTime'} -> 'exist'
//   {op:'eq', value:null, field:'assignedResourceID'} -> 'notExist'
//   {op:'eq', value:null, field:'billingApprovalDateTime'} -> 'notExist'
//
// These tests assert on the OUTGOING FILTER BODY for the same reason the
// ticket-payload tests assert on the outgoing payload: the operator is
// accepted by every type and every schema right up until Autotask ignores it.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskService } from '../src/services/autotask.service';
import {
  QUERY_OPERATORS,
  assertValidFilters,
  type QueryFilter,
} from '../src/services/autotask-http';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockLogger = new Logger('error');

const configWithUrl: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'test-username',
    secret: 'test-secret',
    integrationCode: 'test-integration-code',
    apiUrl: 'https://example.autotask.net/atservicesrest/',
  },
};

function jsonResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

let fetchSpy: jest.SpiedFunction<typeof fetch>;

/** Capture the `filter` array of the first /query POST the service makes. */
function captureFilters(): () => any[] {
  let captured: any[] = [];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(init!.body as string);
    if (body?.filter) captured = body.filter;
    return jsonResponse({ items: [], pageDetails: { nextPageUrl: null } });
  });
  return () => captured;
}

afterEach(() => {
  if (fetchSpy) fetchSpy.mockRestore();
});

describe('assertValidFilters', () => {
  test('accepts every canonical operator', () => {
    for (const op of QUERY_OPERATORS) {
      const f = [{ op, field: 'x', value: 1 } as QueryFilter];
      expect(() => assertValidFilters(f)).not.toThrow();
    }
  });

  test.each(['ne', 'isnotnull', 'isnull', 'beginsw', 'endsw', 'neq', 'not'])(
    'rejects %s, which Autotask would silently discard',
    (op) => {
      expect(() => assertValidFilters([{ op } as unknown as QueryFilter]))
        .toThrow(/Invalid Autotask filter operator/);
    }
  );

  test('rejects eq/noteq against null and names the right operator', () => {
    expect(() => assertValidFilters([
      { op: 'eq', field: 'assignedResourceID', value: null },
    ])).toThrow(/notExist/);
    expect(() => assertValidFilters([
      { op: 'noteq', field: 'assignedResourceID', value: null },
    ])).toThrow(/notExist/);
  });

  test('a legitimate eq against a falsy non-null value still passes', () => {
    // Guard against over-eager null checking: 0, false and '' are real values.
    expect(() => assertValidFilters([{ op: 'eq', field: 'a', value: 0 }])).not.toThrow();
    expect(() => assertValidFilters([{ op: 'eq', field: 'b', value: false }])).not.toThrow();
    expect(() => assertValidFilters([{ op: 'eq', field: 'c', value: '' }])).not.toThrow();
  });

  test('recurses into and/or grouping nodes', () => {
    const nested = [
      { op: 'or', items: [
        { op: 'eq', field: 'a', value: 1 },
        { op: 'ne', field: 'b', value: 2 },
      ] },
    ] as unknown as QueryFilter[];
    expect(() => assertValidFilters(nested)).toThrow(/filter\[0\]\.items\[1\]/);
  });
});

describe('searchTickets filter operators', () => {
  test('the default "open tickets only" filter uses noteq, not ne', async () => {
    // With 'ne' this filter was discarded and the search returned COMPLETED
    // tickets -- directly contradicting the tool's documented default.
    const filters = captureFilters();
    const service = new AutotaskService(configWithUrl, mockLogger);
    await service.searchTickets({});

    expect(filters()).toContainEqual({ op: 'noteq', field: 'status', value: 5 });
    expect(filters().some((f: any) => f.op === 'ne')).toBe(false);
  });

  test('unassigned:true uses notExist, not eq-null', async () => {
    // `{op:'eq', value:null}` matches nothing, so this search -- the one that
    // exists to surface tickets nobody owns -- always returned zero rows.
    const filters = captureFilters();
    const service = new AutotaskService(configWithUrl, mockLogger);
    await service.searchTickets({ unassigned: true });

    expect(filters()).toContainEqual({ op: 'notExist', field: 'assignedResourceID' });
    expect(filters().some((f: any) => f.value === null)).toBe(false);
  });

  test('an explicit status still filters by equality', async () => {
    const filters = captureFilters();
    const service = new AutotaskService(configWithUrl, mockLogger);
    await service.searchTickets({ status: 8 });

    expect(filters()).toContainEqual({ op: 'eq', field: 'status', value: 8 });
    expect(filters().some((f: any) => f.op === 'noteq')).toBe(false);
  });
});

describe('searchTimeEntries approval filters', () => {
  test('approvalStatus "approved" uses exist, not isnotnull', async () => {
    const filters = captureFilters();
    const service = new AutotaskService(configWithUrl, mockLogger);
    await service.searchTimeEntries({ approvalStatus: 'approved' } as any);

    expect(filters()).toContainEqual({ op: 'exist', field: 'billingApprovalDateTime' });
  });

  test('approvalStatus "unapproved" uses notExist, not eq-null', async () => {
    const filters = captureFilters();
    const service = new AutotaskService(configWithUrl, mockLogger);
    await service.searchTimeEntries({ approvalStatus: 'unapproved' } as any);

    expect(filters()).toContainEqual({ op: 'notExist', field: 'billingApprovalDateTime' });
  });
});

describe('every filter the service builds survives validation', () => {
  // A catch-all: exercise the filter-building branches of the busiest search
  // methods and assert none of them emits something Autotask would drop.
  // assertValidFilters runs inside query(), so a bad operator throws here.
  test('representative searches build only valid filters', async () => {
    captureFilters();
    const service = new AutotaskService(configWithUrl, mockLogger);

    await expect(service.searchTickets({
      searchTerm: 'T2026', companyID: 1, contactID: 2, assignedResourceID: 3,
      createdAfter: '2026-01-01', createdBefore: '2026-02-01',
      lastActivityAfter: '2026-01-15',
    } as any)).resolves.toBeDefined();

    await expect(service.searchTimeEntries({
      resourceId: 1, ticketId: 2, taskId: 3,
      dateWorkedAfter: '2026-01-01', dateWorkedBefore: '2026-02-01',
      billable: true, approvalStatus: 'approved',
    } as any)).resolves.toBeDefined();

    await expect(service.searchCompanies({
      searchTerm: 'Acme', isActive: true,
    } as any)).resolves.toBeDefined();
  });
});
