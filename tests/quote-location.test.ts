// QuoteLocation tests.
//
// Quotes.billToLocationID / shipToLocationID / soldToLocationID reference the
// QuoteLocations entity, NOT CompanyLocations. The two have independent id
// sequences that OVERLAP, so passing a CompanyLocation id into a quote either
// gets rejected outright or -- worse -- is silently accepted as a different
// address belonging to a different company.
//
// Measured against the live API on 2026-07-08 and re-confirmed 2026-09-15:
//
//   CompanyLocations/2 = "PO Box 1134, Fairhope AL"     (companyID 29687686)
//   QuoteLocations/2   = "2411 Wolf Ridge Rd, Mobile AL"
//
// Same id, different company, different address. Nothing errors; the quote
// simply carries somebody else's address. That is the leak these tests exist
// to keep closed, so they assert on the OUTGOING REQUESTS -- which entity is
// written and which ids land on the quote -- rather than on return values.
//
// This shipped for months as a build-time .patch file applied by a Dockerfile
// outside this repo. When the deploy path changed, the patch stopped being
// applied and nothing noticed, because a patch file has no tests. Hence these.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

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

function jsonResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

interface Call { method: string; url: string; body: any }

/**
 * Stub fetch and record every request. `company` is what GET /Companies/{id}
 * returns; null makes that route answer HTTP 404, which is what Autotask
 * actually sends for a company that does not exist and what
 * AutotaskHttpClient.get() maps to null. (Returning an empty 200 body instead
 * would NOT exercise the same branch: get() falls back to the raw response
 * when there is no `item` key, so `{}` comes back truthy.)
 */
function stubApi(company: any | null, opts: { quoteLocationIds?: number[] } = {}) {
  const calls: Call[] = [];
  const locIds = [...(opts.quoteLocationIds ?? [901, 902, 903])];

  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (method === 'GET' && /\/Companies\/\d+$/.test(url)) {
      if (company === null) return jsonResponse({ errors: ['not found'] }, 404);
      return jsonResponse({ item: company });
    }
    if (method === 'POST' && url.endsWith('/QuoteLocations')) {
      return jsonResponse({ itemId: locIds.shift() });
    }
    if (method === 'POST' && url.endsWith('/Quotes')) {
      return jsonResponse({ itemId: 5000 });
    }
    if (method === 'POST' && url.includes('/query')) {
      return jsonResponse({ items: [], pageDetails: { nextPageUrl: null } });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });

  return { calls, spy };
}

const ACME = {
  id: 77,
  companyName: 'Acme',
  address1: '1 Main St',
  address2: 'Suite 4',
  city: 'Mobile',
  state: 'AL',
  postalCode: '36618',
};

let active: { spy: jest.SpiedFunction<typeof fetch> } | null = null;
afterEach(() => {
  if (active) active.spy.mockRestore();
  active = null;
});

describe('createQuote location handling', () => {
  test('creates a QuoteLocation and never reads CompanyLocations', async () => {
    const api = stubApi(ACME);
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({ companyID: 77 } as any);

    // The bug: sourcing ids from CompanyLocations. That entity must not be touched.
    expect(api.calls.some(c => c.url.includes('CompanyLocations'))).toBe(false);

    const created = api.calls.filter(c => c.method === 'POST' && c.url.endsWith('/QuoteLocations'));
    expect(created).toHaveLength(1);
    expect(created[0].body).toEqual({
      address1: '1 Main St',
      address2: 'Suite 4',
      city: 'Mobile',
      state: 'AL',
      postalCode: '36618',
    });

    const quote = api.calls.find(c => c.url.endsWith('/Quotes'))!.body;
    expect(quote.billToLocationID).toBe(901);
    expect(quote.shipToLocationID).toBe(901);
    expect(quote.soldToLocationID).toBe(901);
  });

  test('never reuses a row: a second quote for the same company gets a new one', async () => {
    // QuoteLocations are per-quote snapshots. Reusing a row couples quotes
    // together, so editing one address silently rewrites it on every quote
    // pointing at that row -- and leaks across clients when a company's
    // address is only partially populated.
    const api = stubApi(ACME, { quoteLocationIds: [901, 902] });
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({ companyID: 77 } as any);
    await service.createQuote({ companyID: 77 } as any);

    const created = api.calls.filter(c => c.method === 'POST' && c.url.endsWith('/QuoteLocations'));
    expect(created).toHaveLength(2);

    const quotes = api.calls.filter(c => c.url.endsWith('/Quotes')).map(c => c.body);
    expect(quotes[0].billToLocationID).toBe(901);
    expect(quotes[1].billToLocationID).toBe(902);
  });

  test('caller-supplied location IDs are left alone', async () => {
    const api = stubApi(ACME);
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({
      companyID: 77,
      billToLocationID: 11,
      shipToLocationID: 22,
      soldToLocationID: 33,
    } as any);

    expect(api.calls.some(c => c.url.endsWith('/QuoteLocations'))).toBe(false);
    const quote = api.calls.find(c => c.url.endsWith('/Quotes'))!.body;
    expect(quote.billToLocationID).toBe(11);
    expect(quote.shipToLocationID).toBe(22);
    expect(quote.soldToLocationID).toBe(33);
  });

  test('a partially-supplied set fills only the missing ids', async () => {
    const api = stubApi(ACME);
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({ companyID: 77, billToLocationID: 11 } as any);

    const quote = api.calls.find(c => c.url.endsWith('/Quotes'))!.body;
    expect(quote.billToLocationID).toBe(11);
    expect(quote.shipToLocationID).toBe(901);
    expect(quote.soldToLocationID).toBe(901);
  });

  test('a company with no address still produces a snapshot row, not a borrowed id', async () => {
    // Empty strings are correct here. The failure mode being avoided is
    // reaching for SOME other row when the company's own address is blank.
    const api = stubApi({ id: 78, companyName: 'Sparse' });
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({ companyID: 78 } as any);

    const created = api.calls.filter(c => c.url.endsWith('/QuoteLocations'));
    expect(created).toHaveLength(1);
    expect(created[0].body).toEqual({
      address1: '', address2: '', city: '', state: '', postalCode: '',
    });
  });

  test('a missing company sets no location IDs rather than guessing', async () => {
    const api = stubApi(null);
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({ companyID: 999 } as any);

    expect(api.calls.some(c => c.url.endsWith('/QuoteLocations'))).toBe(false);
    const quote = api.calls.find(c => c.url.endsWith('/Quotes'))!.body;
    expect(quote.billToLocationID).toBeUndefined();
    expect(quote.shipToLocationID).toBeUndefined();
    expect(quote.soldToLocationID).toBeUndefined();
  });

  test('a quote with no companyID skips location handling entirely', async () => {
    const api = stubApi(ACME);
    active = api;
    const service = new AutotaskService(config, mockLogger);

    await service.createQuote({ title: 'no company' } as any);

    expect(api.calls.some(c => c.url.endsWith('/QuoteLocations'))).toBe(false);
    expect(api.calls.some(c => c.url.includes('/Companies/'))).toBe(false);
  });
});
