// autotask_create_time_entry role resolution for ticket/task entries.
//
// Once createTimeEntry() stopped 404ing (see create-time-entry-endpoint.test.ts),
// Autotask rejects a ticket/task time entry that carries no roleID. The
// resolution order, in full:
//
//   1. an explicit roleID, verified against the logging resource's active
//      roles (a wrong id is caught here instead of reaching Autotask with a
//      message that names nothing useful)
//   2. an explicit roleName, matched case-insensitively against exactly one
//      active role
//   3. the parent ticket/task's assigned role, but only when the parent is
//      assigned to this SAME resource
//   4. the resource's only active role
//   5. the resource's active role flagged isDefault
//   6. otherwise: refused, with the resource's active roles spelled out
//
// Regular Time (no ticket/task) never triggers any of this.
//
// Ported from wyre-technology/autotask-mcp@7e6eb6b (#281) and @8276622 (#298),
// with step 1 made stricter (explicit roleID is verified, not trusted) and
// step 5 (isDefault fallback) added -- neither is in upstream.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

const RESOURCE = 29682885;

function makeHandler() {
  const service = new AutotaskService(config, logger);
  const getTicketSpy = jest.spyOn(service, 'getTicket');
  const getTaskSpy = jest.spyOn(service, 'getTask');
  const createSpy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(4242);
  // No active roles unless a test says otherwise, so the fallback to the
  // resource's own roles is observable as its "no active roles" error.
  const rolesSpy = jest.spyOn(service, 'searchResourceRoles').mockResolvedValue([]);
  const handler = new AutotaskToolHandler(service, logger);
  return { service, handler, getTicketSpy, getTaskSpy, createSpy, rolesSpy };
}

const EIGHT_ROLES = [
  { roleID: 1, roleName: 'Help Desk', resourceID: RESOURCE, isActive: true },
  { roleID: 2, roleName: 'Administration', resourceID: RESOURCE, isActive: true },
  { roleID: 3, roleName: 'Engineer', resourceID: RESOURCE, isActive: true },
];

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autotask_create_time_entry roleID resolution', () => {
  test('step 1: an explicit roleID that matches an active role is used, with no parent lookup', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue(EIGHT_ROLES);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5, roleID: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(getTicketSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ ticketID: 48231, roleID: 2 }));
  });

  test('step 1: an explicit roleID that is NOT one of the resource\'s active roles is refused, naming the valid ones', async () => {
    const { handler, createSpy, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue(EIGHT_ROLES);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5, roleID: 999,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Help Desk (roleID 1)');
    expect(result.content[0].text).toContain('Administration (roleID 2)');
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('step 2: roleName matches exactly one active role case-insensitively, with no parent lookup', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue(EIGHT_ROLES);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5, roleName: 'administration',
    });

    expect(result.isError).toBeFalsy();
    expect(getTicketSpy).not.toHaveBeenCalled();
    const payload = createSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.roleID).toBe(2);
    expect(payload).not.toHaveProperty('roleName');
  });

  test('step 2: roleName matching no active role is refused, naming the valid ones', async () => {
    const { handler, createSpy, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue(EIGHT_ROLES);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5, roleName: 'Nonexistent Role',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no active role named/);
    expect(result.content[0].text).toContain('Nonexistent Role');
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('step 2: roleName matching more than one active role is refused', async () => {
    const { handler, createSpy, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue([
      { roleID: 1, roleName: 'Help Desk', resourceID: RESOURCE, isActive: true },
      { roleID: 2, roleName: 'Help Desk', resourceID: RESOURCE, isActive: true },
    ]);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5, roleName: 'Help Desk',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/matches more than one/);
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('step 3 (ticket-scoped): inherits the parent\'s role when the ticket is assigned to this same resource', async () => {
    const { handler, getTicketSpy, getTaskSpy, createSpy, rolesSpy } = makeHandler();
    getTicketSpy.mockResolvedValue({ id: 48231, assignedResourceID: RESOURCE, assignedResourceRoleID: 7 } as any);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5,
    });

    expect(result.isError).toBeFalsy();
    expect(getTicketSpy).toHaveBeenCalledWith(48231);
    expect(getTaskSpy).not.toHaveBeenCalled();
    expect(rolesSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ ticketID: 48231, roleID: 7 }));
  });

  test('step 3 (task-scoped): inherits the parent\'s role when the task is assigned to this same resource', async () => {
    const { handler, getTicketSpy, getTaskSpy, createSpy } = makeHandler();
    getTaskSpy.mockResolvedValue({ id: 777, assignedResourceID: RESOURCE, assignedResourceRoleID: 9 } as any);

    const result = await handler.callTool('autotask_create_time_entry', {
      taskID: 777, resourceID: RESOURCE, hoursWorked: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(getTaskSpy).toHaveBeenCalledWith(777);
    expect(getTicketSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ taskID: 777, roleID: 9 }));
  });

  test('a parent assigned to someone else does not lend its role: falls through to the resource\'s own roles', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    getTicketSpy.mockResolvedValue({ id: 48231, assignedResourceID: 99999, assignedResourceRoleID: 7 } as any);
    rolesSpy.mockResolvedValue([{ roleID: 5, roleName: 'Help Desk', resourceID: RESOURCE, isActive: true }]);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5,
    });

    expect(result.isError).toBeFalsy();
    expect(rolesSpy).toHaveBeenCalledWith(RESOURCE);
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ ticketID: 48231, roleID: 5 }));
  });

  test('step 4: an unassigned parent falls back to the resource\'s only active role', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    getTicketSpy.mockResolvedValue({ id: 48231 } as any);
    rolesSpy.mockResolvedValue([{ roleID: 5, roleName: 'Help Desk', resourceID: RESOURCE, isActive: true }]);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5,
    });

    expect(result.isError).toBeFalsy();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ roleID: 5 }));
  });

  test('step 5: several active roles, one flagged isDefault, none assigned by the parent -- the default wins', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    getTicketSpy.mockResolvedValue({ id: 48231 } as any);
    rolesSpy.mockResolvedValue([
      { roleID: 1, roleName: 'Help Desk', resourceID: RESOURCE, isActive: true },
      { roleID: 2, roleName: 'Administration', resourceID: RESOURCE, isActive: true, isDefault: true },
      { roleID: 3, roleName: 'Engineer', resourceID: RESOURCE, isActive: true },
    ]);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5,
    });

    expect(result.isError).toBeFalsy();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ roleID: 2 }));
  });

  test('step 6: several active roles, none default, no parent assignment -- refused, naming them (Phillip\'s real shape: 8 roles, no default)', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    getTicketSpy.mockResolvedValue({ id: 1532069 } as any);
    rolesSpy.mockResolvedValue(EIGHT_ROLES);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 1532069, resourceID: RESOURCE, hoursWorked: 0.02,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Help Desk (roleID 1)');
    expect(result.content[0].text).toContain('Administration (roleID 2)');
    expect(result.content[0].text).toContain('Engineer (roleID 3)');
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('step 6: no active roles at all is refused', async () => {
    const { handler, getTicketSpy, createSpy, rolesSpy } = makeHandler();
    getTicketSpy.mockResolvedValue({ id: 48231 } as any);
    rolesSpy.mockResolvedValue([]);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no active roles');
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('throws when the ticketID does not resolve to a ticket', async () => {
    const { handler, getTicketSpy, createSpy } = makeHandler();
    getTicketSpy.mockResolvedValue(null);

    const result = await handler.callTool('autotask_create_time_entry', {
      ticketID: 99999, resourceID: RESOURCE, hoursWorked: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No Ticket found matching');
    expect(result.content[0].text).toContain('99999');
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('throws when the taskID does not resolve to a task', async () => {
    const { handler, getTaskSpy, createSpy } = makeHandler();
    getTaskSpy.mockResolvedValue(null);

    const result = await handler.callTool('autotask_create_time_entry', {
      taskID: 99999, resourceID: RESOURCE, hoursWorked: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No Task found matching');
    expect(createSpy).not.toHaveBeenCalled();
  });

  test('Regular Time entries (no ticket/task) never trigger role resolution', async () => {
    const { handler, getTicketSpy, getTaskSpy, createSpy, rolesSpy } = makeHandler();

    const result = await handler.callTool('autotask_create_time_entry', {
      resourceID: RESOURCE, hoursWorked: 1, internalBillingCodeID: 3,
    });

    expect(result.isError).toBeFalsy();
    expect(getTicketSpy).not.toHaveBeenCalled();
    expect(getTaskSpy).not.toHaveBeenCalled();
    expect(rolesSpy).not.toHaveBeenCalled();
    expect((createSpy.mock.calls[0][0] as any).roleID).toBeUndefined();
  });

  test('roleName never reaches the outgoing payload', async () => {
    const { handler, createSpy, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue(EIGHT_ROLES);

    await handler.callTool('autotask_create_time_entry', {
      ticketID: 48231, resourceID: RESOURCE, hoursWorked: 1.5, roleName: 'Engineer',
    });

    const payload = createSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('roleName');
    expect(payload.roleID).toBe(3);
  });
});
