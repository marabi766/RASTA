import ts from 'typescript';
import { z } from 'zod';

import { CONTRACT_COMMANDS } from '@/lib/contract-command-fields';
import { DISPUTE_COMMANDS } from '@/lib/transaction-dispute-fields';
import { INVENTORY_COMMANDS } from '@/lib/inventory-commands';
import { ORDER_COMMANDS } from '@/lib/order-fields';
import { OWNER_COMMANDS } from '@/lib/tender-owner-fields';
import type { FieldMapping } from '@/server/write';

import { codeOf, exportsOf, fileOf, kindOf, sourceModules, sourceOf } from './module-discovery';

/**
 * Every entry point that turns what a person typed, or what a service said,
 * into text on a form — found in the sources, not listed (Codex PR-439 r1 F4,
 * addendum G). Two kinds:
 *
 *  - a PARSER: every `legacyParse(…)` / `legacyParseAsync(…)` call and every
 *    `parseMoneyInput(…)` call outside `lib/format`, in any module under
 *    `lib/`, `server/`, `app/` or `ui/`, private schemas and schemas built
 *    inside a function included;
 *  - a MAPPING: every `FieldMapping` declaration — a constant, a constant a
 *    factory builds, or the factory itself — exported or not.
 *
 * An entry point whose value the module exports is swept as it is. Any other
 * needs a test ADAPTER below (how to reach it through the module's own public
 * entry point) or an EXCLUSION with its reason. A discovered entry point with
 * neither fails; an adapter or exclusion nothing matches fails; and a known
 * set (the review's) must be among the discovered, so a discovery that quietly
 * finds less fails closed.
 */

const DIRS = ['lib', 'server', 'app', 'ui'] as const;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface EntryPoint {
  /** `module:name` — the module and the schema / mapping expression it uses. */
  readonly key: string;
  readonly module: string;
  readonly name: string;
}

function sourceFileOf(module: string): ts.SourceFile {
  const file = fileOf(module);
  return ts.createSourceFile(file, sourceOf(module), ts.ScriptTarget.Latest, true, kindOf(file));
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const PARSE_CALL = new Set(['legacyParse', 'legacyParseAsync']);

/** Every parse call site: the schema expression it parses with. */
export function discoverParsers(): EntryPoint[] {
  const found = new Map<string, EntryPoint>();
  for (const module of sourceModules(DIRS)) {
    if (!/legacyParse|parseMoneyInput/.test(codeOf(module))) continue;
    walk(sourceFileOf(module), (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const callee = node.expression.text;
      let name: string | undefined;
      if (PARSE_CALL.has(callee)) {
        const schema = node.arguments[0];
        name = schema === undefined ? '<none>' : schema.getText().replace(/\[.*$/s, '');
      } else if (callee === 'parseMoneyInput' && !module.startsWith('lib/format/')) {
        name = 'parseMoneyInput';
      }
      if (name !== undefined)
        found.set(`${module}:${name}`, { key: `${module}:${name}`, module, name });
    });
  }
  return [...found.values()];
}

/** Every FieldMapping declaration: constants (any scope), factory-built constants, factories. */
type MappingEntry = EntryPoint & { readonly factory: boolean; readonly builtBy?: string };

export function discoverMappings(): MappingEntry[] {
  const found = new Map<string, MappingEntry>();
  for (const module of sourceModules(DIRS)) {
    if (!/FieldMapping/.test(codeOf(module)) || module === 'server/write') continue;
    const source = sourceFileOf(module);
    const factories = new Set<string>();
    walk(source, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.type &&
        /^FieldMapping\b/.test(node.type.getText())
      ) {
        factories.add(node.name.text);
      }
    });
    walk(source, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && factories.has(node.name.text)) {
        const name = node.name.text;
        found.set(`${module}:${name}`, { key: `${module}:${name}`, module, name, factory: true });
      }
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
      const typed = node.type !== undefined && /^FieldMapping\b/.test(node.type.getText());
      const init = node.initializer;
      const built =
        init !== undefined &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        factories.has(init.expression.text);
      if (typed || built) {
        const name = node.name.text;
        const builtBy = built ? (init.expression as ts.Identifier).text : undefined;
        found.set(`${module}:${name}`, {
          key: `${module}:${name}`,
          module,
          name,
          factory: false,
          ...(builtBy ? { builtBy: `${module}:${builtBy}` } : {}),
        });
      }
    });
  }
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Adapters and exclusions
// ---------------------------------------------------------------------------

/** What a parser shows for one hostile value in every field: field errors and a form message. */
export type ParserAdapter = (hostile: string) => string[];

/** A FormData that answers `hostile` for every field except those fixed. */
export function hostileForm(hostile: string, fixed: Record<string, string> = {}): FormData {
  const value = (name: string) => (Object.hasOwn(fixed, name) ? fixed[name]! : hostile);
  return {
    get: value,
    getAll: (name: string) => [value(name)],
    has: () => true,
    entries: () => Object.entries(fixed)[Symbol.iterator](),
  } as unknown as FormData;
}

const fill = <F extends string>(fields: readonly F[], hostile: string) =>
  Object.fromEntries(fields.map((field) => [field, hostile])) as Record<F, string>;

/** Everything a parse result would put in front of a person. */
export function shownBy(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const { fieldErrors, message } = result as { fieldErrors?: unknown; message?: unknown };
  const fields =
    typeof fieldErrors === 'object' && fieldErrors !== null ? Object.values(fieldErrors) : [];
  return [...fields, message].filter((text): text is string => typeof text === 'string');
}

/* eslint-disable @typescript-eslint/no-explicit-any -- adapters call each module's own entry point */
export const PARSER_ADAPTERS: Readonly<Record<string, ParserAdapter>> = {
  'lib/project-commands:projectFormSchema': (h) => {
    const m = exportsOf('lib/project-commands') as any;
    const values = m.projectFormValues(hostileForm(h));
    return [...shownBy(m.parseCreateForm(values)), ...shownBy(m.parseEditForm(values, new Set()))];
  },
  'lib/project-commands:reasonSchema': (h) => {
    const m = exportsOf('lib/project-commands') as any;
    return shownBy(m.parseCancelForm(m.cancelFormValues(hostileForm(h))));
  },
  'lib/project-commands:grantSchema': (h) => {
    const m = exportsOf('lib/project-commands') as any;
    return shownBy(m.parseGrantForm(m.grantFormValues(hostileForm(h))));
  },
  'lib/project-commands:rejectSchema': (h) => {
    const m = exportsOf('lib/project-commands') as any;
    return shownBy(m.parseRejectForm(m.rejectFormValues(hostileForm(h))));
  },
  'lib/project-commands:parseMoneyInput': (h) => {
    const m = exportsOf('lib/project-commands') as any;
    return shownBy({ message: m.parseEstimate(h).message });
  },
  'server/place-order:placeOrderSchema': (h) => {
    const m = exportsOf('server/place-order') as any;
    return shownBy(m.parsePlaceOrderForm(m.placeOrderFormValues(hostileForm(h))));
  },
  'server/orders:COMMAND_SCHEMAS': (h) => {
    const m = exportsOf('server/orders') as any;
    return ORDER_COMMANDS.flatMap((command) =>
      shownBy(m.parseOrderCommand(m.orderCommandFormValues(hostileForm(h, { command })))),
    );
  },
  'server/transactions:COMMAND_SCHEMAS': (h) => {
    const m = exportsOf('server/transactions') as any;
    return DISPUTE_COMMANDS.flatMap((command) =>
      shownBy(m.parseDisputeCommand(m.disputeFormValues(hostileForm(h, { command })))),
    );
  },
  'server/asset-commands:schema': (h) => {
    const m = exportsOf('server/asset-commands') as any;
    const fields = exportsOf('lib/asset-form-fields').UPDATE_ASSET_FIELDS as readonly string[];
    return shownBy(m.parseUpdateAssetForm(fill(fields, h), fields));
  },
  'lib/bid-input:parseMoneyInput': (h) => {
    const m = exportsOf('lib/bid-input') as any;
    return shownBy(m.parseBid(m.bidFormValues(hostileForm(h))));
  },
  'lib/contract-command-input:parseMoneyInput': (h) => {
    const m = exportsOf('lib/contract-command-input') as any;
    return CONTRACT_COMMANDS.flatMap((command) =>
      shownBy(m.parseCommandInput(command, m.commandFormValues(hostileForm(h), command))),
    );
  },
  'lib/statement-draft:parseMoneyInput': (h) => {
    const m = exportsOf('lib/statement-draft') as any;
    return shownBy(m.parseDraft(m.draftFormLines(hostileForm(h)), null));
  },
  'server/wallet:parseMoneyInput': (h) => {
    const m = exportsOf('server/wallet') as any;
    return shownBy(m.parseTopUpForm({ amountMinor: h }));
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Parse sites deliberately not driven here, each with why. */
export const PARSER_EXCLUSIONS: Readonly<Record<string, string>> = {
  'lib/form-resolver:schema':
    'the form resolver itself: its words are formIssueMessage’s, and form-resolver.spec drives it against zodResolver',
  'server/env:schema':
    'server configuration, never shown on a form; a path-only reader (form-issues.spec)',
  'server/oidc:tokenResponseSchema':
    'the identity provider’s token response, never shown on a form; a path-only reader (form-issues.spec)',
  'server/repair-order-commands:parseMoneyInput':
    'inside the exported repair-order …FormSchemas (rialAmount), swept as such',
  'server/asset-records:parseMoneyInput':
    'inside the exported policy …FormSchema (optionalRials), swept as such',
  'ui/form/MoneyField:parseMoneyInput':
    'the browser widget: it shows moneyInputMessage(failure) only (form.spec.tsx drives it with hostile input)',
};

/**
 * A helper's schema parameter: the parse call is in the helper, the schemas
 * are its callers' arguments. Each caller's argument must be an exported
 * schema, which is then swept like any other (else it is unaccounted).
 */
export const PARSER_DELEGATES: Readonly<Record<string, RegExp>> = {
  'lib/supplier-commands:schema': /(?<!function )\bparseWith(?:<[^>]*>)?\(\s*(\w+)/g,
};

export const MAPPING_ADAPTERS: Readonly<Record<string, () => FieldMapping<string>[]>> = {
  'server/tender-bids:bidFieldMapping': () => {
    const { bidFieldMapping } = exportsOf('server/tender-bids') as {
      bidFieldMapping: (rows?: readonly number[]) => FieldMapping<string>;
    };
    return [bidFieldMapping(), bidFieldMapping([0, 1])];
  },
  'server/contract-statements:statementFieldMapping': () => {
    const { statementFieldMapping } = exportsOf('server/contract-statements') as {
      statementFieldMapping: (rows?: readonly number[]) => FieldMapping<string>;
    };
    return [statementFieldMapping(), statementFieldMapping([0, 1])];
  },
  'server/returns:returnRequestFieldMapping': () => {
    const { returnRequestFieldMapping } = exportsOf('server/returns') as {
      returnRequestFieldMapping: (body: unknown) => FieldMapping<string>;
    };
    return [
      returnRequestFieldMapping({ reason: 'x', lines: [] }),
      returnRequestFieldMapping({ reason: 'x', lines: [{ orderLineId: 'OL_1', quantity: 1 }] }),
    ];
  },
  'server/inventory-commands:inventoryFieldMapping': () => {
    const { inventoryFieldMapping } = exportsOf('server/inventory-commands') as {
      inventoryFieldMapping: (command: string, body: unknown) => FieldMapping<string>;
    };
    return INVENTORY_COMMANDS.map((command) => inventoryFieldMapping(command, null));
  },
  'server/tender-owner:mappingFor': () => {
    const { mappingFor } = exportsOf('server/tender-owner') as {
      mappingFor: (command: string, paths: Record<string, string>) => FieldMapping<string>;
    };
    return OWNER_COMMANDS.map((command) => mappingFor(command, { reason: 'reason' }));
  },
};

/** Private factories that only build the module's exported constants (checked below). */
const ONLY_BUILDS_EXPORTED =
  'a private factory: every mapping it builds is an exported constant, swept as such';
export const MAPPING_EXCLUSIONS: Readonly<Record<string, string>> = {
  'server/supplier-commands:mappingOf': ONLY_BUILDS_EXPORTED,
  'server/repair-order-commands:mappingOf': ONLY_BUILDS_EXPORTED,
  'server/asset-records:mappingOf': ONLY_BUILDS_EXPORTED,
  'server/project-commands:mappingOf': ONLY_BUILDS_EXPORTED,
  'server/asset-lifecycle-commands:mappingOf': ONLY_BUILDS_EXPORTED,
};

/** The review's set (PR-439 r1 F4, addendum G): discovery that finds fewer fails. */
export const KNOWN_PARSERS = [
  'server/orders:COMMAND_SCHEMAS',
  'server/place-order:placeOrderSchema',
  'server/transactions:COMMAND_SCHEMAS',
  'lib/project-commands:projectFormSchema',
  'server/wallet:parseMoneyInput',
] as const;
export const KNOWN_MAPPINGS = [
  'server/tender-bids:bidFieldMapping',
  'server/contract-statements:statementFieldMapping',
  'server/tender-owner:mappingFor',
  'server/returns:returnRequestFieldMapping',
  'server/fleet-availability:REVOKE_MAPPING',
] as const;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Whether every call of `factory` in `module` is the initializer of an exported constant. */
export function onlyBuildsExported(module: string, factory: string): boolean {
  const code = codeOf(module);
  const calls = code.match(new RegExp(`\\b${factory}\\s*(<[^>]*>)?\\(`, 'g')) ?? [];
  const exported =
    code.match(new RegExp(`export const \\w+\\s*=\\s*${factory}\\s*(<[^>]*>)?\\(`, 'g')) ?? [];
  // One call is the declaration itself (`function mappingOf<…>(`).
  return calls.length - 1 === exported.length;
}

export interface ResolvedParsers {
  readonly schemas: ReadonlyArray<readonly [string, z.ZodTypeAny]>;
  readonly adapters: ReadonlyArray<readonly [string, ParserAdapter]>;
  readonly unaccounted: readonly string[];
  readonly stale: readonly string[];
  readonly discovered: readonly string[];
}

export function resolveParsers(): ResolvedParsers {
  const found = discoverParsers();
  const schemas: Array<readonly [string, z.ZodTypeAny]> = [];
  const adapters: Array<readonly [string, ParserAdapter]> = [];
  const unaccounted: string[] = [];
  for (const entry of found) {
    const exported = exportsOf(entry.module)[entry.name];
    if (exported instanceof z.ZodType) schemas.push([`${entry.module}.${entry.name}`, exported]);
    else if (Object.hasOwn(PARSER_ADAPTERS, entry.key))
      adapters.push([entry.key, PARSER_ADAPTERS[entry.key]!]);
    else if (Object.hasOwn(PARSER_DELEGATES, entry.key)) {
      const callers = [...codeOf(entry.module).matchAll(PARSER_DELEGATES[entry.key]!)];
      if (callers.length === 0) unaccounted.push(entry.key);
      for (const [, name] of callers) {
        const schema = exportsOf(entry.module)[name!];
        if (schema instanceof z.ZodType) schemas.push([`${entry.module}.${name}`, schema]);
        else unaccounted.push(`${entry.key} <- ${name}`);
      }
    } else if (!Object.hasOwn(PARSER_EXCLUSIONS, entry.key)) unaccounted.push(entry.key);
  }
  const keys = found.map((entry) => entry.key);
  const stale = [
    ...Object.keys(PARSER_ADAPTERS),
    ...Object.keys(PARSER_EXCLUSIONS),
    ...Object.keys(PARSER_DELEGATES),
  ].filter((key) => !keys.includes(key));
  return { schemas, adapters, unaccounted, stale, discovered: keys };
}

export interface ResolvedMappings {
  readonly mappings: ReadonlyArray<readonly [string, FieldMapping<string>]>;
  readonly unaccounted: readonly string[];
  readonly stale: readonly string[];
  readonly discovered: readonly string[];
}

export function resolveMappings(): ResolvedMappings {
  const found = discoverMappings();
  const mappings: Array<readonly [string, FieldMapping<string>]> = [];
  const unaccounted: string[] = [];
  for (const entry of found) {
    const exported = exportsOf(entry.module)[entry.name];
    if (
      !entry.factory &&
      typeof exported === 'object' &&
      exported !== null &&
      'paths' in exported
    ) {
      mappings.push([entry.key, exported as FieldMapping<string>]);
    } else if (entry.builtBy !== undefined && Object.hasOwn(MAPPING_ADAPTERS, entry.builtBy)) {
      // Built inside a function by a factory whose adapter sweeps what it builds.
    } else if (Object.hasOwn(MAPPING_ADAPTERS, entry.key)) {
      MAPPING_ADAPTERS[entry.key]!().forEach((mapping, index) =>
        mappings.push([`${entry.key}#${index}`, mapping]),
      );
    } else if (!(
      Object.hasOwn(MAPPING_EXCLUSIONS, entry.key) && onlyBuildsExported(entry.module, entry.name)
    )) {
      unaccounted.push(entry.key);
    }
  }
  const keys = found.map((entry) => entry.key);
  const stale = [...Object.keys(MAPPING_ADAPTERS), ...Object.keys(MAPPING_EXCLUSIONS)].filter(
    (key) => !keys.includes(key),
  );
  return { mappings, unaccounted, stale, discovered: keys };
}
