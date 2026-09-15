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

/** Capture the body POSTed to /Contacts. */
function captureContactPost(): () => any {
  let body: any;
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.endsWith('/Contacts')) body = JSON.parse(init!.body as string);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ itemId: 321 }),
      json: async () => ({ itemId: 321 }),
    } as unknown as Response;
  });
  return () => body;
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
