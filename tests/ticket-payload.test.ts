// Ticket write-payload tests.
//
// buildTicketPayload() in tool.handler.ts copies an allow-list of fields out of
// the caller's arguments and into the body sent to Autotask. Anything the tool
// schema declares but the allow-list omits is accepted from the caller without
// complaint and then dropped on the floor.
//
// That failure mode has now happened three times (issueType/subIssueType, then
// assignedResourceRoleID and dueDateTime), so these tests assert on the OUTGOING
// PAYLOAD rather than on the schema. A schema-only test passes happily for the
// entire life of this bug: the field is declared, it just never ships.

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

const mockConfig: McpServerConfig = {
  name: 'test-server',
  version: '1.0.0',
  autotask: {
    username: 'test-username',
    secret: 'test-secret',
    integrationCode: 'test-integration-code'
  }
};

const mockLogger = new Logger('error');

// Arguments consumed by the handler itself rather than forwarded to Autotask.
const NON_PAYLOAD_ARGS = new Set(['ticketId']);

const declaredProps = (toolName: string): string[] => {
  const tool = TOOL_DEFINITIONS.find(t => t.name === toolName);
  if (!tool) throw new Error(`tool definition missing: ${toolName}`);
  return Object.keys(tool.inputSchema.properties as Record<string, unknown>)
    .filter(k => !NON_PAYLOAD_ARGS.has(k));
};

// A value of the right shape for each declared field, so the whole surface can
// be pushed through the handler in one call.
const sampleFor = (field: string): unknown => {
  switch (field) {
    case 'title': return 'sample title';
    case 'description': return 'sample description';
    case 'resolution': return 'sample resolution';
    case 'dueDateTime': return '2026-03-15T17:00:00Z';
    case 'ticketAdditionalContacts': return [1, 2];
    case 'userDefinedFields': return [{ name: 'Some UDF', value: 'x' }];
    default: return 1;
  }
};

describe('ticket write payload', () => {
  describe('drift guard', () => {
    // The guard that generalises the fix. Declaring a new field on either ticket
    // tool without adding it to TICKET_WRITABLE_FIELDS fails here, at the point
    // the field is added, rather than silently in production months later.
    test.each(['autotask_create_ticket', 'autotask_update_ticket'])(
      'every field %s declares reaches the outgoing payload',
      async (toolName) => {
        const fields = declaredProps(toolName);
        expect(fields.length).toBeGreaterThan(0);

        const service = new AutotaskService(mockConfig, mockLogger);
        const createSpy = jest.spyOn(service, 'createTicket').mockResolvedValue(1 as any);
        const updateSpy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
        const handler = new AutotaskToolHandler(service, mockLogger);

        const args: Record<string, unknown> = { ticketId: 42 };
        for (const f of fields) args[f] = sampleFor(f);

        await handler.callTool(toolName, args);

        const payload = (toolName === 'autotask_create_ticket'
          ? createSpy.mock.calls[0]?.[0]
          : updateSpy.mock.calls[0]?.[1]) as Record<string, unknown> | undefined;

        expect(payload).toBeDefined();
        const dropped = fields.filter(f => payload![f] === undefined);
        expect(dropped).toEqual([]);
      }
    );
  });

  describe('assignedResourceRoleID', () => {
    // Autotask answers a body carrying assignedResourceID without its role with
    // "Data violation: When assigning a Resource, you must assign both a
    // assignedResourceID and assignedResourceRoleID." Dropping the role made
    // every assigned-resource call fail, so tickets could only be filed
    // unassigned -- into a queue with nobody watching them.
    test('create forwards the resource and its role together', async () => {
      const service = new AutotaskService(mockConfig, mockLogger);
      const createSpy = jest.spyOn(service, 'createTicket').mockResolvedValue(7 as any);
      const handler = new AutotaskToolHandler(service, mockLogger);

      await handler.callTool('autotask_create_ticket', {
        companyID: 1001,
        title: 'sample title',
        description: 'sample description',
        assignedResourceID: 2002,
        assignedResourceRoleID: 3003
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      const payload = createSpy.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.assignedResourceID).toBe(2002);
      expect(payload.assignedResourceRoleID).toBe(3003);
    });

    test('update forwards the resource and its role together', async () => {
      const service = new AutotaskService(mockConfig, mockLogger);
      const updateSpy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
      const handler = new AutotaskToolHandler(service, mockLogger);

      await handler.callTool('autotask_update_ticket', {
        ticketId: 4004,
        assignedResourceID: 2002,
        assignedResourceRoleID: 3003
      });

      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [id, payload] = updateSpy.mock.calls[0] as [number, Record<string, unknown>];
      expect(id).toBe(4004);
      expect(payload.assignedResourceID).toBe(2002);
      expect(payload.assignedResourceRoleID).toBe(3003);
    });

    test('a resource never ships without its role', async () => {
      // The pair is what Autotask validates. If one is forwarded the other must
      // be too, whichever way a future refactor moves them.
      const service = new AutotaskService(mockConfig, mockLogger);
      const createSpy = jest.spyOn(service, 'createTicket').mockResolvedValue(7 as any);
      const handler = new AutotaskToolHandler(service, mockLogger);

      await handler.callTool('autotask_create_ticket', {
        companyID: 1,
        title: 't',
        description: 'd',
        assignedResourceID: 2002,
        assignedResourceRoleID: 3003
      });

      const payload = createSpy.mock.calls[0][0] as Record<string, unknown>;
      expect('assignedResourceID' in payload).toBe('assignedResourceRoleID' in payload);
    });
  });

  describe('dueDateTime', () => {
    // Worse than the role bug in one way: this one failed silently. The update
    // returned success and the due date simply never changed.
    test('update forwards dueDateTime', async () => {
      const service = new AutotaskService(mockConfig, mockLogger);
      const updateSpy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
      const handler = new AutotaskToolHandler(service, mockLogger);

      await handler.callTool('autotask_update_ticket', {
        ticketId: 42,
        dueDateTime: '2026-03-15T17:00:00Z'
      });

      const [, payload] = updateSpy.mock.calls[0] as [number, Record<string, unknown>];
      expect(payload.dueDateTime).toBe('2026-03-15T17:00:00Z');
    });
  });

  describe('payload hygiene', () => {
    test('unknown arguments are still dropped', async () => {
      // The allow-list exists for a reason; widening it must not turn into
      // passing the caller's whole argument bag through to Autotask.
      const service = new AutotaskService(mockConfig, mockLogger);
      const createSpy = jest.spyOn(service, 'createTicket').mockResolvedValue(7 as any);
      const handler = new AutotaskToolHandler(service, mockLogger);

      await handler.callTool('autotask_create_ticket', {
        companyID: 1,
        title: 't',
        description: 'd',
        notAField: 'should not be forwarded'
      });

      const payload = createSpy.mock.calls[0][0] as Record<string, unknown>;
      expect('notAField' in payload).toBe(false);
    });

    test('fields the caller omits are not sent as undefined', async () => {
      const service = new AutotaskService(mockConfig, mockLogger);
      const updateSpy = jest.spyOn(service, 'updateTicket').mockResolvedValue(undefined as any);
      const handler = new AutotaskToolHandler(service, mockLogger);

      await handler.callTool('autotask_update_ticket', { ticketId: 42, status: 5 });

      const [, payload] = updateSpy.mock.calls[0] as [number, Record<string, unknown>];
      expect(Object.keys(payload)).toEqual(['status']);
    });
  });
});
