// Regression tests for the time-entry 404: createTimeEntry() routed
// ticket-/task-scoped entries through child collection routes
// (POST /Tickets/{id}/TimeEntries, POST /Tasks/{id}/TimeEntries) that do not
// exist on any Autotask zone -- TimeEntries is a top-level entity, so those
// 404'd every single time. Seen live on T20261030.0019 (ticket 1532069): the
// same payload sent as POST /TimeEntries with ticketID in the body succeeded.
//
// Ported from wyre-technology/autotask-mcp@aa021e1 (#279), adapted to this
// fork's service layer (native fetch via AutotaskHttpClient, not the
// autotask-node SDK).

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    // Pre-set apiUrl so baseUrl() resolves without a zone-info network round-trip.
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

/** Answer every request with one canned body. */
function mockFetchOk(body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

/** "<METHOD> <pathname>" trace of every fetch call, so a failing assertion names the exact route requested. */
function calledRoutes(fetchMock: jest.SpyInstance): string[] {
  return fetchMock.mock.calls.map(
    (c: any[]) => `${(c[1] as RequestInit).method} ${new URL(c[0] as string).pathname}`
  );
}

function firstRequestBody(fetchMock: jest.SpyInstance): any {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AutotaskService.createTimeEntry() endpoint', () => {
  // One behaviour, three shapes: the scope lives in the payload, so the route
  // is the same unconditional POST /TimeEntries for all of them.
  test.each([
    ['ticket-scoped', { ticketID: 1532069, resourceID: 12, roleID: 29683567, hoursWorked: 1.5 }],
    ['task-scoped', { taskID: 777, resourceID: 12, roleID: 501, hoursWorked: 2 }],
    ['regular time (no parent)', { resourceID: 12, hoursWorked: 1, internalBillingCodeID: 3 }],
  ])('%s entries POST to /TimeEntries with the parent in the body', async (_label, payload) => {
    const fetchMock = mockFetchOk({ itemId: 4242 });

    const service = new AutotaskService(config, logger);
    await expect(service.createTimeEntry(payload as any)).resolves.toBe(4242);

    const routes = calledRoutes(fetchMock);
    expect(routes).toEqual(['POST /ATServicesRest/v1.0/TimeEntries']);
    // The bug this pins: never the nonexistent child collection routes.
    expect(routes.some(r => /\/Tickets\/\d+\/TimeEntries$/.test(r))).toBe(false);
    expect(routes.some(r => /\/Tasks\/\d+\/TimeEntries$/.test(r))).toBe(false);
    expect(firstRequestBody(fetchMock)).toMatchObject(payload);
  });
});
