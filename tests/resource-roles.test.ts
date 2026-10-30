// autotask_search_resource_roles -- lists the billing roles a resource holds,
// so a caller can pass roleName/roleID to autotask_create_time_entry instead
// of guessing (Autotask answers a wrong id with "Role does not exist or is
// invalid", which names nothing useful).
//
// Ported from wyre-technology/autotask-mcp@8276622 (#298), trimmed to the
// tool surface -- the resolution order itself is covered by
// tests/create-time-entry-roleid.test.ts.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
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

function makeHandler() {
  const service = new AutotaskService(config, logger);
  const rolesSpy = jest.spyOn(service, 'searchResourceRoles').mockResolvedValue([
    { roleID: 501, roleName: 'Help Desk', resourceID: 29682885, isActive: true },
    { roleID: 502, roleName: 'Engineer', resourceID: 29682885, isActive: true },
  ]);
  const resolveByNameSpy = jest.spyOn(service, 'resolveResourceByName');
  const handler = new AutotaskToolHandler(service, logger);
  return { service, handler, rolesSpy, resolveByNameSpy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autotask_search_resource_roles', () => {
  test('is advertised, read-only, and filed under resources', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_search_resource_roles');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_CATEGORIES.resources.tools).toContain('autotask_search_resource_roles');
  });

  test('lists a resource\'s roles by resourceId', async () => {
    const { handler, rolesSpy } = makeHandler();

    const result = await handler.callTool('autotask_search_resource_roles', { resourceId: 29682885 });

    expect(result.isError).toBeFalsy();
    expect(rolesSpy).toHaveBeenCalledWith(29682885, false);
    const text = (result.content[0] as any).text as string;
    expect(text).toContain('Help Desk (roleID 501)');
    expect(text).toContain('Engineer (roleID 502)');
  });

  test('resolves resourceName to a resourceId when no id is given', async () => {
    const { handler, rolesSpy, resolveByNameSpy } = makeHandler();
    resolveByNameSpy.mockResolvedValue({ id: 29682885, firstName: 'Phillip', lastName: 'Long' } as any);

    const result = await handler.callTool('autotask_search_resource_roles', { resourceName: 'Phillip Long' });

    expect(result.isError).toBeFalsy();
    expect(rolesSpy).toHaveBeenCalledWith(29682885, false);
  });

  test('passes includeInactive through', async () => {
    const { handler, rolesSpy } = makeHandler();

    await handler.callTool('autotask_search_resource_roles', { resourceId: 29682885, includeInactive: true });

    expect(rolesSpy).toHaveBeenCalledWith(29682885, true);
  });

  test('requires resourceId or resourceName', async () => {
    const { handler } = makeHandler();

    const result = await handler.callTool('autotask_search_resource_roles', {});

    expect(result.isError).toBe(true);
  });

  test('zero roles is reported through the same not-found guard every search tool uses', async () => {
    // Every autotask_search_* tool turns an empty array into an explicit
    // error rather than a silent empty result, to stop a caller from reading
    // "no roles" as "role lookup skipped". autotask_search_resource_roles is
    // no exception.
    const { handler, rolesSpy } = makeHandler();
    rolesSpy.mockResolvedValue([]);

    const result = await handler.callTool('autotask_search_resource_roles', { resourceId: 1 });

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toMatch(/zero results/);
  });
});
