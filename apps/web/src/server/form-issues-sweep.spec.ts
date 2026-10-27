/**
 * @jest-environment node
 */
import { z } from 'zod';
import { LegacyContextError, legacyParse } from '@rasta/contracts';

import { firstIssuePerField, GENERIC_FIELD_MESSAGE } from '@/lib/form-issues';

import * as assetCommands from './asset-commands';
import * as assetDocuments from './asset-documents';
import * as assetLifecycle from './asset-lifecycle-commands';
import * as assetRecords from './asset-records';
import * as assignments from './assignments';
import * as drivers from './drivers';
import * as fleetAvailability from './fleet-availability';
import * as maintenanceCommands from './maintenance-commands';
import * as members from './members';
import * as organizations from './organizations';
import * as repairOrderCommands from './repair-order-commands';
import * as usage from './usage';
import * as supplierCommands from '@/lib/supplier-commands';

/**
 * Every local form schema the portal exports, with hostile input in every
 * field: whatever a person would be shown for a failed field is Persian. The
 * sweep finds the schemas by the `…FormSchema` naming convention, so a new
 * parser is covered the day it is exported; a floor on the count fails the
 * test if the convention is ever abandoned.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const MODULES: Record<string, Record<string, unknown>> = {
  'asset-commands': assetCommands,
  'asset-documents': assetDocuments,
  'asset-lifecycle-commands': assetLifecycle,
  'asset-records': assetRecords,
  assignments,
  drivers,
  'fleet-availability': fleetAvailability,
  'maintenance-commands': maintenanceCommands,
  members,
  organizations,
  'repair-order-commands': repairOrderCommands,
  'supplier-commands': supplierCommands,
  usage,
};

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject) return current.shape as Record<string, z.ZodTypeAny>;
    // A refinement is a check on the object itself; a transform or preprocess is a pipe.
    if (current instanceof z.ZodPipe)
      current = (current.in instanceof z.ZodTransform ? current.out : current.in) as z.ZodType;
    else return null;
  }
  return null;
}

const FORM_SCHEMAS = Object.entries(MODULES).flatMap(([module, exports]) =>
  Object.entries(exports)
    .filter(([name, value]) => /FormSchema$/.test(name) && value instanceof z.ZodType)
    .map(([name, value]) => [`${module}.${name}`, value as z.ZodTypeAny] as const),
);

const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
  ['empty', ''],
  ['very long text', 'ب'.repeat(5000)],
  ['400 digits', '9'.repeat(400)],
  ['a bidi control', 'ab‮cd'],
  ['a negative number', '-1'],
  ['an exponent', '1e999'],
  ['not a number', 'NaN'],
  ['an array holding an empty string', ['']],
  ['a long array', Array.from({ length: 500 }, () => 'x')],
  ['null', null],
  ['a number', 12],
  ['an object', { a: 1 }],
];

describe('every exported local form schema answers in Persian', () => {
  it('finds the schemas (the naming convention still holds)', () => {
    expect(FORM_SCHEMAS.length).toBeGreaterThanOrEqual(25);
  });

  it.each(FORM_SCHEMAS)('%s: whatever fails is shown in Persian', (_name, schema) => {
    const shape = shapeOf(schema);
    expect(shape).not.toBeNull();
    const fields = Object.keys(shape!);

    let failures = 0;
    for (const [, hostile] of HOSTILE) {
      const result = legacyParse(
        schema,
        Object.fromEntries(fields.map((field) => [field, hostile])),
      );
      if (result.success) continue;
      for (const message of Object.values(firstIssuePerField(result.refusal, fields))) {
        failures += 1;
        expect(message).toMatch(/\p{Script=Arabic}/u);
        // A Latin word may sit inside a Persian sentence (a brand, a unit);
        // an all-English sentence may not.
        expect(message).not.toMatch(/^\p{ASCII}+$/u);
        expect(message).not.toMatch(/must contain|Expected|Invalid|Required|received/i);
        expect(message).not.toContain('9'.repeat(10));
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  it('answers one generic Persian sentence for an issue nobody foresaw', () => {
    const unknown = legacyParse(
      z.object({ name: z.string() }).superRefine((_value, ctx) => {
        ctx.addIssue({ code: 'custom', path: ['name'], message: 'Something nobody foresaw' });
      }),
      { name: 'x' },
    );
    expect(unknown.refusal && firstIssuePerField(unknown.refusal, ['name'])).toEqual({
      name: GENERIC_FIELD_MESSAGE,
    });
  });

  it('refuses a bare zod error: without the parse that raised it, no sentence is guessed (r1 F1)', () => {
    const bare = z.object({ name: z.string() }).safeParse({}).error;
    expect(() => firstIssuePerField(bare as never, ['name'])).toThrow(LegacyContextError);
  });
});
