// QuoteItem create defaults and update routing.
//
// Both defects here were found by verifying #9 against the live API on
// 2026-09-15 -- neither was caught by #9's own 15 tests, because a mock
// accepts any JSON and any route. Same lesson as #8, which existed because
// #7's 13 payload-asserting tests could not see that Autotask would reject
// the value they proved was being sent.
//
// 1. DEFEATED DEFAULTS. createQuoteItem declares four defaults, but the tool
//    handler forwards a fixed list of argument names, so every optional one
//    arrives as an explicit `undefined` when the caller omits it. Spreading
//    that over the defaults replaced them with `undefined`, JSON.stringify
//    dropped the keys, and Autotask rejected the create -- all four are
//    required on QuoteItems:
//
//      POST /Quotes/5150/Items {no isOptional}
//        -> HTTP 500 "Missing Required Field: isOptional. ; on record number [1]"
//      POST /Quotes/5150/Items {isOptional: false}
//        -> HTTP 500 "Missing Required Field: unitDiscount. ; on record number [1]"
//
//    It failed, then failed again naming the next field, until all four were
//    passed by hand. So the defaults applied to nobody who relied on them.
//
// 2. DEAD UPDATE ROUTE. Both legs of http.update() dead-end for QuoteItems on
//    this zone, exactly as they do for Contacts:
//
//      PATCH /QuoteItems        -> 404 (collection route absent)
//      PUT   /QuoteItems/{id}   -> 405 "does not support http method 'PUT'"
//      PATCH /Quotes/{id}/Items -> 200, itemId returned
//
//    autotask_update_quote_item was impossible, not merely degraded. #9 added
//    periodType and isTaxable to its schema -- fields on a tool that could not
//    run at all.
//
// These assert on the OUTGOING REQUESTS: which route is called and which keys
// survive into the body.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const mockLogger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'u', secret: 's', integrationCode: 'i',
    apiUrl: 'https://example.autotask.net/atservicesrest/',
  },
};

interface Call { method: string; url: string; body: any }

let fetchSpy: jest.SpiedFunction<typeof fetch>;
afterEach(() => { if (fetchSpy) fetchSpy.mockRestore(); });

function ok(payload: any): Response {
  return {
    ok: true, status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
}

/** `existingItem` is what GET /QuoteItems/{id} returns, used to resolve the parent quote. */
function captureCalls(existingItem: any = { id: 34876, quoteID: 5150 }): () => Call[] {
  const calls: Call[] = [];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && /\/QuoteItems\/\d+$/.test(url)) return ok({ item: existingItem });
    return ok({ itemId: 34876 });
  });
  return () => calls;
}

const newHandler = () =>
  new AutotaskToolHandler(new AutotaskService(config, mockLogger), mockLogger);

const created = (calls: Call[]) =>
  calls.find(c => c.method === 'POST' && /\/Quotes\/\d+\/Items$/.test(c.url))?.body;

const REQUIRED_ON_CREATE = ['isOptional', 'unitDiscount', 'lineDiscount', 'percentageDiscount'];

describe('autotask_create_quote_item defaults survive an omitting caller', () => {
  test('every field Autotask requires is present when the caller omits all of them', async () => {
    // The exact call that returned "Missing Required Field: isOptional."
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5150, serviceID: 3, quantity: 1, unitPrice: 75.32
    });

    const body = created(calls());
    for (const field of REQUIRED_ON_CREATE) {
      expect(body).toHaveProperty(field);
      expect(body[field]).not.toBeUndefined();
    }
    expect(body.isOptional).toBe(false);
    expect(body.unitDiscount).toBe(0);
    expect(body.lineDiscount).toBe(0);
    expect(body.percentageDiscount).toBe(0);
  });

  test('an explicit true/non-zero from the caller wins over the default', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5150, serviceID: 3, quantity: 1,
      isOptional: true, unitDiscount: 5, lineDiscount: 2, percentageDiscount: 10
    });

    expect(created(calls())).toMatchObject({
      isOptional: true, unitDiscount: 5, lineDiscount: 2, percentageDiscount: 10
    });
  });

  test('an explicit false/zero is not mistaken for absent and re-defaulted', async () => {
    // The trap in fixing this with `??` per field: false and 0 are the same
    // values the defaults supply, so a wrong fix looks correct here. What
    // must hold is that the caller's value is what ships.
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5150, serviceID: 3, quantity: 1,
      isOptional: false, unitDiscount: 0
    });

    const body = created(calls());
    expect(body.isOptional).toBe(false);
    expect(body.unitDiscount).toBe(0);
  });

  test('a falsy value on a field with NO default still ships', async () => {
    // isTaxable is the discriminating case. For the four defaulted fields an
    // explicit `false`/`0` is indistinguishable from the default they supply,
    // so a fix that strips every falsy value looks correct on them. isTaxable
    // has no default: strip it and the key vanishes entirely, which is a
    // different outcome from sending false.
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5150, serviceID: 3, quantity: 1, isTaxable: false
    });

    const body = created(calls());
    expect(body).toHaveProperty('isTaxable');
    expect(body.isTaxable).toBe(false);
  });

  test('no key is sent with an undefined value', async () => {
    // The root cause, stated directly: undefined must never reach the body.
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5150, serviceID: 3, quantity: 1
    });

    const body = created(calls());
    for (const [k, v] of Object.entries(body)) {
      expect([k, v]).not.toEqual([k, undefined]);
    }
  });

  test('periodType and isTaxable still reach the body (#9 stays fixed)', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_create_quote_item', {
      quoteId: 5150, serviceID: 3, quantity: 1, periodType: 4, isTaxable: true
    });

    expect(created(calls())).toMatchObject({ periodType: 4, isTaxable: true });
  });
});

describe('autotask_update_quote_item uses the child route', () => {
  test('PATCHes /Quotes/{quoteID}/Items, never /QuoteItems', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 34876, periodType: 2
    });

    const patches = calls().filter(c => c.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toMatch(/\/Quotes\/5150\/Items$/);
    expect(patches[0].body).toMatchObject({ id: 34876, periodType: 2 });
  });

  test('never falls back to PUT /QuoteItems/{id}', async () => {
    // The dead leg: 405 on this zone. Reaching it at all means the route is wrong.
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 34876, quantity: 2
    });

    expect(calls().some(c => c.method === 'PUT')).toBe(false);
    expect(calls().some(c => c.method === 'PATCH' && /\/QuoteItems$/.test(c.url))).toBe(false);
  });

  test('resolves the parent quote by reading the item when not supplied', async () => {
    const calls = captureCalls({ id: 34876, quoteID: 9999 });

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 34876, quantity: 2
    });

    expect(calls().some(c => c.method === 'GET' && /\/QuoteItems\/34876$/.test(c.url))).toBe(true);
    expect(calls().find(c => c.method === 'PATCH')!.url).toMatch(/\/Quotes\/9999\/Items$/);
  });

  test('a caller-supplied quoteID saves the lookup', async () => {
    // Exercised at the SERVICE level deliberately: the tool schema has no
    // quoteID, so the handler cannot supply one. The branch still matters --
    // other callers use the service directly, and a lookup per update is a
    // round trip nobody needs when the parent is already known.
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateQuoteItem(34876, { quoteID: 7777, quantity: 2 } as any);

    expect(calls().some(c => c.method === 'GET' && /\/QuoteItems\//.test(c.url))).toBe(false);
    expect(calls().find(c => c.method === 'PATCH')!.url).toMatch(/\/Quotes\/7777\/Items$/);
  });

  test('omitted fields are not sent as undefined', async () => {
    const calls = captureCalls();

    await newHandler().callTool('autotask_update_quote_item', {
      quoteItemId: 34876, periodType: 2
    });

    const body = calls().find(c => c.method === 'PATCH')!.body;
    expect(body).not.toHaveProperty('quantity');
    expect(body).not.toHaveProperty('unitPrice');
    expect(body).not.toHaveProperty('isTaxable');
  });

  test('an unresolvable parent quote fails loudly rather than guessing', async () => {
    // callTool converts a thrown error into an isError envelope rather than
    // rejecting, so assert on what a caller actually sees.
    const calls = captureCalls(null);

    const res = await newHandler().callTool(
      'autotask_update_quote_item', { quoteItemId: 34876, quantity: 2 }
    );

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text)
      .toMatch(/unable to resolve parent quoteID/);
    // The point of failing: no write went out against a guessed parent.
    expect(calls().some(c => c.method === 'PATCH')).toBe(false);
  });
});
