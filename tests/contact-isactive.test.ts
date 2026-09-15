// Contacts.isActive tests.
//
// Autotask declares isActive as REQUIRED on the Contacts entity and rejects a
// create that omits it:
//
//   HTTP 500 "Missing Required Field: isActive."
//
// Confirmed from the entity metadata rather than the error message alone --
// GET /Contacts/entityInformation/fields reports isActive with
// isRequired: true, dataType: integer (checked 2026-09-15). Callers rarely
// think to send it, so createContact defaults it.
//
// The dataType matters. The field is an INTEGER; the tool schema exposes a
// BOOLEAN because that is the honest shape for a caller. Something has to
// convert, and these tests pin that it happens here rather than being left to
// Autotask to coerce.
//
// Like the quote-location tests, these assert on the OUTGOING PAYLOAD. This
// shipped for months as a build-time .patch applied by a Dockerfile in another
// repo; when the deploy path changed the patch stopped being applied and
// nothing noticed, because a patch file has no tests.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
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

let fetchSpy: jest.SpiedFunction<typeof fetch>;
afterEach(() => { if (fetchSpy) fetchSpy.mockRestore(); });

interface Call { method: string; url: string; body: any }

function ok(payload: any): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as unknown as Response;
}

/**
 * Record every request. `existingContact` is what GET /Contacts/{id} returns,
 * used by updateContact to resolve the parent companyID.
 */
function captureCalls(existingContact: any = { id: 555, companyID: 77 }): () => Call[] {
  const calls: Call[] = [];
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    if (method === 'GET' && /\/Contacts\/\d+$/.test(url)) return ok({ item: existingContact });
    return ok({ itemId: 321 });
  });
  return () => calls;
}

/** The body POSTed when creating a contact, whichever route was used. */
function captureContactPost(): () => any {
  const calls = captureCalls();
  return () => calls().find(c => c.method === 'POST' && c.url.includes('Contacts'))?.body;
}

describe('createContact defaults isActive', () => {
  test('omitted → 1, so the create is not rejected', async () => {
    const body = captureContactPost();
    const service = new AutotaskService(config, mockLogger);

    await service.createContact({ companyID: 77, firstName: 'A', lastName: 'B' } as any);

    expect(body().isActive).toBe(1);
  });

  test('sent as an integer → passed through unchanged', async () => {
    const body = captureContactPost();
    const service = new AutotaskService(config, mockLogger);

    await service.createContact({ companyID: 77, isActive: 0 } as any);

    expect(body().isActive).toBe(0);
  });

  test('sent as a boolean → converted to the integer the field actually is', async () => {
    // The schema advertises boolean, the entity is integer. If this conversion
    // is dropped, the payload carries `true`/`false` into an integer field and
    // its fate is Autotask's to decide rather than ours.
    const service = new AutotaskService(config, mockLogger);

    const bodyTrue = captureContactPost();
    await service.createContact({ companyID: 77, isActive: true } as any);
    expect(bodyTrue().isActive).toBe(1);
    fetchSpy.mockRestore();

    const bodyFalse = captureContactPost();
    await service.createContact({ companyID: 77, isActive: false } as any);
    expect(bodyFalse().isActive).toBe(0);
  });

  test('an explicit false is honoured, not overwritten by the default', async () => {
    // The bug a naive `payload.isActive ||= 1` would introduce: a caller
    // deliberately creating an inactive contact gets an active one.
    const body = captureContactPost();
    const service = new AutotaskService(config, mockLogger);

    await service.createContact({ companyID: 77, isActive: false } as any);

    expect(body().isActive).toBe(0);
    expect(body().isActive).not.toBe(1);
  });

  test('the caller object is not mutated', async () => {
    // createContact builds its own payload; a caller reusing their object
    // should not find an isActive it never set.
    captureContactPost();
    const service = new AutotaskService(config, mockLogger);
    const input = { companyID: 77, firstName: 'A' } as any;

    await service.createContact(input);

    expect('isActive' in input).toBe(false);
  });
});

describe('autotask_create_contact schema', () => {
  test('advertises isActive so a caller can set it', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_contact');
    expect(tool).toBeDefined();
    const props = tool!.inputSchema.properties as Record<string, any>;
    expect(props.isActive).toBeDefined();
    expect(props.isActive.type).toBe('boolean');
  });

  test('the description states the default', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_contact');
    expect(tool!.description).toMatch(/isActive/i);
  });
});

describe('contacts use the Companies child route, which is the only one this zone registers', () => {
  // Probed against webservices5 on 2026-09-15, each request built so it could
  // not succeed (empty body, or a nonexistent id):
  //
  //   POST  /Contacts                  -> IIS HTML 404          route absent
  //   POST  /Companies/{id}/Contacts   -> 500 Missing Required Field: isActive
  //   PATCH /Contacts                  -> IIS HTML 404          route absent
  //   PUT   /Contacts/{id}             -> 405 no such method
  //   PATCH /Companies/{id}/Contacts   -> 500 No matching records found
  //
  // A 500 means the route resolved and the request was rejected on its merits;
  // the 404s are IIS saying the route was never registered. So BOTH legs of
  // http.update() dead-end for Contacts here -- contact updates were not
  // degraded, they were impossible.

  test('create posts to /Companies/{id}/Contacts, never the bare collection', async () => {
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.createContact({ companyID: 77, firstName: 'A' } as any);

    const post = calls().find(c => c.method === 'POST')!;
    expect(post.url).toMatch(/\/Companies\/77\/Contacts$/);
    expect(post.url).not.toMatch(/\/v1\.0\/Contacts$/);
  });

  test('create without companyID fails fast instead of 404ing', async () => {
    captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await expect(service.createContact({ firstName: 'A' } as any))
      .rejects.toThrow(/companyID is required/);
  });

  test('update patches /Companies/{id}/Contacts, never the bare collection or PUT', async () => {
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { firstName: 'Changed' } as any);

    const patch = calls().find(c => c.method === 'PATCH')!;
    expect(patch.url).toMatch(/\/Companies\/77\/Contacts$/);
    expect(patch.body).toMatchObject({ id: 555, firstName: 'Changed' });
    expect(calls().some(c => c.method === 'PUT')).toBe(false);
    expect(calls().some(c => /\/v1\.0\/Contacts$/.test(c.url))).toBe(false);
  });

  test('update takes companyID from the payload without a lookup when given', async () => {
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { companyID: 88, firstName: 'X' } as any);

    expect(calls().some(c => c.method === 'GET')).toBe(false);
    expect(calls().find(c => c.method === 'PATCH')!.url).toMatch(/\/Companies\/88\/Contacts$/);
  });

  test('update looks the contact up when the payload omits companyID', async () => {
    const calls = captureCalls({ id: 555, companyID: 99 });
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { firstName: 'X' } as any);

    expect(calls().some(c => c.method === 'GET' && /\/Contacts\/555$/.test(c.url))).toBe(true);
    expect(calls().find(c => c.method === 'PATCH')!.url).toMatch(/\/Companies\/99\/Contacts$/);
  });

  test('update fails with a clear message when the parent cannot be resolved', async () => {
    // Better than letting it fall through to a route that answers HTML.
    captureCalls({ id: 555 });
    const service = new AutotaskService(config, mockLogger);

    await expect(service.updateContact(555, { firstName: 'X' } as any))
      .rejects.toThrow(/unable to resolve parent companyID/);
  });
});

describe('updateContact normalises isActive the same way createContact does', () => {
  // Found by LIVE verification after the child-route fix shipped, not by these
  // tests: createContact coerced isActive to an integer and updateContact did
  // not, so a caller passing the boolean the schema advertises got
  //
  //   HTTP 500 Unexpected character encountered while parsing value: f.
  //            Path 'isActive'
  //
  // Autotask does not coerce a boolean into an integer field -- its JSON parser
  // rejects the payload outright. Both paths now share toIsActiveInt().

  test('false becomes 0 instead of reaching Autotask as a boolean', async () => {
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { isActive: false } as any);

    const patch = calls().find(c => c.method === 'PATCH')!;
    expect(patch.body.isActive).toBe(0);
    expect(typeof patch.body.isActive).toBe('number');
  });

  test('true becomes 1', async () => {
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { isActive: true } as any);

    expect(calls().find(c => c.method === 'PATCH')!.body.isActive).toBe(1);
  });

  test('an integer is passed through untouched', async () => {
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { isActive: 0 } as any);

    expect(calls().find(c => c.method === 'PATCH')!.body.isActive).toBe(0);
  });

  test('an update that omits isActive does NOT default it', async () => {
    // The hazard of reusing createContact's logic verbatim: defaulting here
    // would silently reactivate every contact somebody had deactivated,
    // on any unrelated edit.
    const calls = captureCalls();
    const service = new AutotaskService(config, mockLogger);

    await service.updateContact(555, { firstName: 'Changed' } as any);

    const patch = calls().find(c => c.method === 'PATCH')!;
    expect('isActive' in patch.body).toBe(false);
  });

  test('the caller object is not mutated', async () => {
    captureCalls();
    const service = new AutotaskService(config, mockLogger);
    const input = { isActive: false } as any;

    await service.updateContact(555, input);

    expect(input.isActive).toBe(false);
  });
});
