// Field NAMES a write tool sends must exist on the Autotask entity.
//
// A wrong name is worse than a dropped field: Autotask ignores unknown fields on
// write rather than rejecting them, so the call reports success and the value is
// silently discarded — the same failure mode as the dueDateTime drop, and the
// same disease as the cipp-mcp batch ("sending fields CIPP does not read").
//
// Each name below was confirmed non-existent by querying the live API, which DOES
// validate field names on read:
//
//   GET /TimeEntries/query    filter projectID      -> HTTP 500
//       "Unable to find projectID in the TimeEntry Entity."
//   GET /ExpenseReports/query filter description    -> HTTP 500
//       "Unable to find description in the ExpenseReport Entity."
//   GET /Projects/query       filter estimatedHours -> HTTP 500
//       "Unable to find estimatedHours in the Project Entity."
//
// These assert on the OUTGOING PAYLOAD, and they feed the bad name in on purpose:
// removing a parameter from a tool's schema does not stop it arriving, because
// autotask_execute_tool forwards arbitrary arguments. A schema-only assertion
// would pass while the field still shipped.

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
  autotask: { username: 'u', secret: 's', integrationCode: 'i' }
};
const mockLogger = new Logger('error');

const propsOf = (name: string) => {
  const t = TOOL_DEFINITIONS.find(d => d.name === name);
  if (!t) throw new Error(`missing tool definition: ${name}`);
  return t.inputSchema.properties as Record<string, unknown>;
};

describe('autotask_create_time_entry', () => {
  const baseArgs = {
    resourceID: 2002,
    ticketID: 4004,
    dateWorked: '2026-03-15',
    hoursWorked: 1.5,
    summaryNotes: 'work'
  };

  test('does not advertise projectID', () => {
    expect(propsOf('autotask_create_time_entry')).not.toHaveProperty('projectID');
  });

  test('no description still offers a project as a parent for time', () => {
    // Removing the parameter left prose behind: the `category` description
    // continued to read "when no ticket/task/project is specified", pointing
    // readers at a parameter that no longer exists. Prose is part of the
    // interface for an LLM-facing tool -- it is what the model reads to decide
    // what to pass -- so a stale option in a description is a real defect, not
    // a typo.
    //
    // The word "project" is not the defect; a project offered as a PARAMETER
    // is. The tool and taskID descriptions mention projects deliberately, to
    // say that project work is logged against a task. So this matches the shape
    // the stale text had rather than the word: an earlier version of this test
    // banned "project" outright and failed on that deliberate taskID prose.
    const AS_A_PARAMETER = /\/\s*project\b|\bprojectID\b/i;
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_time_entry')!;
    const props = propsOf('autotask_create_time_entry') as Record<string, { description?: string }>;
    const texts: Array<[string, string]> = [
      ['<tool description>', tool.description],
      ...Object.entries(props).map(([n, p]) => [n, p.description ?? ''] as [string, string])
    ];
    for (const [where, text] of texts) {
      expect(`${where}: ${text}`).not.toMatch(AS_A_PARAMETER);
    }
  });

  test('never sends projectID, even when one is passed anyway', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, mockLogger);

    await handler.callTool('autotask_create_time_entry', { ...baseArgs, projectID: 9001 });

    const payload = spy.mock.calls[0][0] as Record<string, unknown>;
    expect('projectID' in payload).toBe(false);
    expect(payload.ticketID).toBe(4004);
  });

  test('a stray projectID no longer suppresses the Regular Time branch', async () => {
    // projectID used to make isRegularTime false, skipping the category
    // requirement and producing an entry with no parent and no billing code.
    // With no ticket or task, this must now prompt for a category instead.
    const service = new AutotaskService(mockConfig, mockLogger);
    const createSpy = jest.spyOn(service, 'createTimeEntry').mockResolvedValue(1 as any);
    jest.spyOn(service, 'getInternalBillingCodeNames').mockResolvedValue(['Internal Meeting']);
    const handler = new AutotaskToolHandler(service, mockLogger);

    const res = await handler.callTool('autotask_create_time_entry', {
      resourceID: 2002,
      projectID: 9001,
      dateWorked: '2026-03-15',
      hoursWorked: 1.5,
      summaryNotes: 'work'
    });

    expect(createSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toMatch(/category/i);
  });
});

describe('autotask_create_expense_report', () => {
  test('does not advertise description', () => {
    expect(propsOf('autotask_create_expense_report')).not.toHaveProperty('description');
  });

  test('never sends description, even when one is passed anyway', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'createExpenseReport').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, mockLogger);

    await handler.callTool('autotask_create_expense_report', {
      name: 'March expenses',
      submitterId: 2002,
      weekEndingDate: '2026-03-15',
      description: 'should not ship'
    });

    const payload = spy.mock.calls[0][0] as Record<string, unknown>;
    expect('description' in payload).toBe(false);
    expect(payload.submitterID).toBe(2002);
    expect(payload.weekEnding).toBe('2026-03-15');
  });
});

describe('autotask_create_project', () => {
  test('sends estimatedTime, never estimatedHours', async () => {
    const service = new AutotaskService(mockConfig, mockLogger);
    const spy = jest.spyOn(service, 'createProject').mockResolvedValue(1 as any);
    const handler = new AutotaskToolHandler(service, mockLogger);

    await handler.callTool('autotask_create_project', {
      companyID: 1001,
      projectName: 'Rollout',
      projectType: 5,
      estimatedHours: 75
    });

    const payload = spy.mock.calls[0][0] as Record<string, unknown>;
    expect('estimatedHours' in payload).toBe(false);
    expect(payload.estimatedTime).toBe(75);
  });

  test('agrees with autotask_update_project on the field name', async () => {
    // The two disagreed: update used the real field, create invented one.
    const service = new AutotaskService(mockConfig, mockLogger);
    const createSpy = jest.spyOn(service, 'createProject').mockResolvedValue(1 as any);
    const updateSpy = jest.spyOn(service, 'updateProject').mockResolvedValue(undefined as any);
    const handler = new AutotaskToolHandler(service, mockLogger);

    await handler.callTool('autotask_create_project', {
      companyID: 1001, projectName: 'Rollout', projectType: 5, estimatedHours: 75
    });
    await handler.callTool('autotask_update_project', { projectId: 5, estimatedTime: 75 });

    const created = createSpy.mock.calls[0][0] as Record<string, unknown>;
    const updated = updateSpy.mock.calls[0][1] as Record<string, unknown>;
    const estimateKey = (o: Record<string, unknown>) =>
      Object.keys(o).find(k => /^estimated(Time|Hours)$/.test(k));
    expect(estimateKey(created)).toBe(estimateKey(updated));
  });
});
