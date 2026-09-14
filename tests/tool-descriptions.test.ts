// A tool's descriptions must not name a parameter the tool does not have.
//
// Descriptions are the interface for an LLM-facing tool: they are what the model
// reads to decide what to pass. A description naming a parameter that was
// removed sends the model looking for something that no longer exists, and a
// description naming one that never existed invents an affordance.
//
// WHAT THIS DOES NOT CATCH — worth stating plainly, because a guard trusted
// beyond its reach is worse than none. It matches camelCase identifiers ending
// in "ID"/"Id", so it catches `projectID` in prose but NOT a parameter referred
// to in words. The real 2026-09-14 instance read "when no ticket/task/project is
// specified" and contains no such token; that regression is pinned separately,
// by name, in tests/write-field-names.test.ts. This guard covers a different
// slice of the same class, not that instance.
//
// The comparison is case-insensitive on purpose. `autotask_search_billing_items`
// declares `invoiceId` and its description says "invoiceID is set", referring to
// the Autotask entity field rather than the parameter. That is legitimate, and
// matching case-insensitively admits it without needing an allowlist — which is
// better than an allowlist, because an allowlist accumulates entries and stops
// being read.
import { test } from '@jest/globals';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';

type Tool = (typeof TOOL_DEFINITIONS)[number];

/** camelCase identifiers ending in ID/Id — the shape of a parameter reference. */
const ID_TOKEN = /\b[a-z][A-Za-z0-9]*I[Dd]\b/g;

const describedTexts = (tool: Tool): Array<[string, string]> => {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  return [
    ['<tool description>', tool.description ?? ''],
    ...Object.entries(props).map(([n, p]) => [n, p?.description ?? ''] as [string, string])
  ];
};

const idTokensIn = (tool: Tool): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const [where, text] of describedTexts(tool))
    for (const m of String(text).matchAll(ID_TOKEN)) out.push([where, m[0]]);
  return out;
};

/** Tokens that look like parameter references but match no declared parameter. */
export const undeclaredIdReferences = (tool: Tool): string[] => {
  const declared = new Set(
    Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>)
      .map(d => d.toLowerCase())
  );
  return idTokensIn(tool)
    .filter(([, tok]) => !declared.has(tok.toLowerCase()))
    .map(([where, tok]) => `${tool.name} (${where}): "${tok}"`);
};

test('the scan is not vacuous — descriptions really are being read', () => {
  // A regex or shape change that quietly stopped matching would make every
  // assertion below pass while checking nothing. Guard the guard.
  const examined = TOOL_DEFINITIONS.reduce((n, t) => n + idTokensIn(t).length, 0);
  expect(TOOL_DEFINITIONS.length).toBeGreaterThan(50);
  expect(examined).toBeGreaterThan(20);
});

test('the check flags a tool whose description names a parameter it lacks', () => {
  // Positive control: prove the checker can fail, rather than trusting that it
  // would. Without this, "0 violations" is indistinguishable from "0 checks".
  const synthetic = {
    name: 'synthetic_tool',
    description: 'Log time against a ticket. Pass projectID to attach it to a project.',
    inputSchema: { type: 'object', properties: { ticketID: { type: 'number', description: 'Ticket ID' } } }
  } as unknown as Tool;

  const found = undeclaredIdReferences(synthetic);
  expect(found).toHaveLength(1);
  expect(found[0]).toContain('projectID');
});

test('the check accepts a case-variant reference to a declared parameter', () => {
  const synthetic = {
    name: 'synthetic_tool',
    description: 'Filter to items where invoiceID is set.',
    inputSchema: { type: 'object', properties: { invoiceId: { type: 'number', description: 'Invoice id' } } }
  } as unknown as Tool;

  expect(undeclaredIdReferences(synthetic)).toEqual([]);
});

test('no tool description names a parameter the tool does not declare', () => {
  const violations = TOOL_DEFINITIONS.flatMap(undeclaredIdReferences);
  expect(violations).toEqual([]);
});
