// QuoteItems.periodType / isTaxable tests.
//
// periodType is what makes a quote line RECURRING. Autotask's picklist, read
// from the live entity metadata on 2026-09-15
// (GET /QuoteItems/entityInformation/fields):
//
//   1 = One-Time   2 = Monthly   3 = Quarterly   4 = Semi-Annual   5 = Yearly
//
// The field is an integer picklist and is NOT required, so a line created
// without it is accepted and bills as a one-time charge. That is the failure:
// an MSP quote for a $500/month managed-services line, created through this
// tool, silently becomes a single $500 charge. Nothing errors, and the
// difference only shows up on an invoice. Real quotes in this tenant carry
// periodType 2 on their recurring lines, so the value is in active use.
//
// Unlike the assignedResourceRoleID drop, this was never an accept-then-
// discard defect in this repo: the tool schema simply never declared either
// field, so there was nothing to drop. It is a missing capability.
//
// These assert on the OUTGOING REQUEST BODY, driven through the tool handler,
// because that is where the gap was -- the handler forwards a fixed list of
// argument names to the service, so a field can be declared in the schema and
// still never reach Autotask. A schema-only assertion would not have caught it.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockLogger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'u',
    secret: 's',
    integrationCode: 'i',
    apiUrl: 'https://example.autotask.net/atservicesrest/',
  },
};

interface Call { method: string; url: string; body: any }

let fetchSpy: jest.SpiedFunction<typeof fetch>;
afterEach(() => { if (fetchSpy) fetchSpy.mockRestore(); });

function ok(payload: any): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
}

function captureCalls(): () => Call[] {
  const calls: Call[] = [];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    // updateQuoteItem reads the item to resolve its parent quote for the
    // Quotes/{quoteID}/Items child route.
    if (method === 'GET' && /\/QuoteItems\/\d+$/.test(url)) {
      return ok({ item: { id: 777, quoteID: 5000 } });
    }
    return ok({ itemId: 4242 });
  });
  return () => calls;
}

function newHandler(): AutotaskToolHandler {
  return new AutotaskToolHandler(new AutotaskService(config, mockLogger), mockLogger);
}

/** Body of the POST that creates the line: POST /Quotes/{id}/Items. */
const createdLine = (calls: Call[]) =>
  calls.find(c => c.method === 'POST' && /\/Quotes\/\d+\/Items$/.test(c.url))?.body;

/**
 * Body of the PATCH that updates the line: PATCH /Quotes/{quoteID}/Items.
 *
 * Not `/QuoteItems` -- that collection route is absent on this zone and the
 * PUT fallback answers 405, so update went through neither. Fixed and pinned
 * in tests/quote-item-write-paths.test.ts.
 */
const patchedLine = (calls: Call[]) =>
  calls.find(c => c.method === 'PATCH' && /\/Quotes\/\d+\/Items$/.test(c.url))?.body;

const propsOf = (name: string) => {
  const t = TOOL_DEFINITIONS.find(d => d.name === name);
  if (!t) throw new Error(`missing tool definition: ${name}`);
  return t.inputSchema.properties as Record<string, { type?: string; description?: string }>;
};

describe('autotask_create_quote_item schema', () => {
  test('advertises periodType as a number', () => {
    expect(propsOf('autotask_create_quote_item').periodType?.type).toBe('number');
  });

  test('advertises isTaxable as a boolean', () => {
    expect(propsOf('autotask_create_quote_item').isTaxable?.type).toBe('boolean');
  });

  test('periodType description names the picklist values', () => {
    // An LLM-facing schema is only usable if it says what the integers mean;
    // "periodType: number" alone is unusable without the Autotask docs open.
    const d = propsOf('autotask_create_quote_item').periodType?.description ?? '';
    for (const v of ['1', '2', '3', '4', '5', 'Monthly', 'Yearly']) {
      expect(d).toContain(v);
    }
  });
});

describe('periodType descriptions state that the caller often does not control it', () => {
  // The original wording said the opposite of what the API does:
  //
  //   "Set it for recurring service lines -- Autotask treats an unset line as
  //    one-time, so a monthly service quoted without it bills once."
  //
  // Verified live on 2026-09-15 against quote 5150, service 3 (own periodType
  // 2): sent 4 -> stored 2; sent 1 -> stored 2. Autotask takes the SERVICE's
  // period and discards the caller's, silently. On a product line an
  // incompatible value is rejected instead:
  //
  //   "When QuoteItem.quoteItemType is set to Product(1) the
  //    QuoteItem.periodType may not be Semi-Annual."
  //
  // A description is the interface for an LLM-facing tool -- it is what the
  // model reads to decide what to pass -- so text that promises control the
  // API does not give is a real defect, and one that would have had a model
  // "fix" a non-problem by setting a field with no effect.

  const TOOLS = ['autotask_create_quote_item', 'autotask_update_quote_item'];

  test.each(TOOLS)('%s says the value is not always the caller\'s', (tool) => {
    const d = propsOf(tool).periodType?.description ?? '';
    expect(d).toMatch(/not caller-controlled/i);
    expect(d).toMatch(/service/i);
  });

  test.each(TOOLS)('%s no longer claims an unset line bills once', (tool) => {
    // The specific false promise, pinned by its shape rather than its exact
    // words so a reworded version of the same claim still fails.
    const d = propsOf(tool).periodType?.description ?? '';
    expect(d).not.toMatch(/unset line as one-time/i);
    expect(d).not.toMatch(/bills once/i);
    expect(d).not.toMatch(/set it for recurring service lines/i);
  });

  test('the tool description does not promise it either', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_quote_item')!;
    expect(tool.description).not.toMatch(/bills as one-time|line bills as one-time/i);
    expect(tool.description).toMatch(/periodType/);
  });
});

describe('autotask_update_quote_item schema', () => {
  // The paired endpoint had the same gap. Without it a line created with the
  // wrong periodType could not be corrected through the tool at all -- the
  // only recovery was deleting the line and re-adding it.
  test('advertises periodType as a number', () => {
    expect(propsOf('autotask_update_quote_item').periodType?.type).toBe('number');
  });

  test('advertises isTaxable as a boolean', () => {
    expect(propsOf('autotask_update_quote_item').isTaxable?.type).toBe('boolean');
  });
});

describe('autotask_create_quote_item outgoing payload', () => {
  test('periodType reaches the request body', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5000, serviceID: 88, quantity: 1, unitPrice: 500, periodType: 2
    });

    expect(createdLine(calls())?.periodType).toBe(2);
  });

  test('isTaxable reaches the request body', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5000, serviceID: 88, quantity: 1, isTaxable: true
    });

    expect(createdLine(calls())?.isTaxable).toBe(true);
  });

  test('isTaxable: false is sent, not swallowed', async () => {
    // A `a.isTaxable || undefined`-style forward would drop this and leave the
    // line taxable by whatever Autotask defaults to. false is a real answer.
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5000, serviceID: 88, quantity: 1, isTaxable: false
    });

    const body = createdLine(calls());
    expect(body).toHaveProperty('isTaxable');
    expect(body.isTaxable).toBe(false);
  });

  test('every picklist value survives the trip', async () => {
    for (const periodType of [1, 2, 3, 4, 5]) {
      const calls = captureCalls();
      await newHandler().callTool('autotask_create_quote_item', {
        quoteId: 5000, serviceID: 88, quantity: 1, periodType
      });
      expect(createdLine(calls())?.periodType).toBe(periodType);
      fetchSpy.mockRestore();
    }
  });

  test('omitting them sends neither key', async () => {
    // Nothing should start writing `periodType: null` into lines that never
    // asked for one; an omitted field must stay omitted.
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5000, serviceID: 88, quantity: 1
    });

    const body = createdLine(calls());
    expect(body).not.toHaveProperty('periodType');
    expect(body).not.toHaveProperty('isTaxable');
  });

  test('neither field disturbs the rest of the line', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5000, serviceID: 88, quantity: 3, unitPrice: 12.5, periodType: 3, isTaxable: true
    });

    expect(createdLine(calls())).toMatchObject({
      quantity: 3,
      unitPrice: 12.5,
      serviceID: 88,
      quoteItemType: 11,
      periodType: 3,
      isTaxable: true,
    });
  });
});

describe('autotask_update_quote_item outgoing payload', () => {
  test('periodType reaches the request body', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 777, periodType: 2
    });

    expect(patchedLine(calls())).toMatchObject({ id: 777, periodType: 2 });
  });

  test('isTaxable reaches the request body, false included', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 777, isTaxable: false
    });

    const body = patchedLine(calls());
    expect(body).toHaveProperty('isTaxable');
    expect(body.isTaxable).toBe(false);
  });

  test('a one-time line can be corrected to monthly without touching price', async () => {
    // The point of porting the update side: fixing the mistake this port
    // exists to prevent, in place, on a quote already built.
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 777, periodType: 2
    });

    const body = patchedLine(calls());
    expect(body.periodType).toBe(2);
    expect(body).not.toHaveProperty('unitPrice');
    expect(body).not.toHaveProperty('quantity');
  });

  test('omitting them sends neither key', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 777, quantity: 2
    });

    const body = patchedLine(calls());
    expect(body).not.toHaveProperty('periodType');
    expect(body).not.toHaveProperty('isTaxable');
  });
});
