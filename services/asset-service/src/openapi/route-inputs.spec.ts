import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject, OperationObject } from '@nestjs/swagger';
import { ID_PREFIXES, ULID_REGEX } from '@rasta/contracts';
import { zodRouteInputKey, zodRouteInputProblems, zodRouteInputs } from '@rasta/nest-common';
import { z } from 'zod';
import { buildAssetOpenApiDocument, buildDocumentationApp } from './document';

type IdentifierPattern = { path: (string | number)[]; pattern: string };

/** Walk the route's validator, independently of the converter and its pattern marker. */
function identifierPatterns(
  schema: z.ZodType,
  path: (string | number)[] = [],
): IdentifierPattern[] {
  if (schema instanceof z.ZodString) {
    const prefix = Object.values(ID_PREFIXES).find((p) => schema.description === `${p} identifier`);
    if (prefix) return [{ path, pattern: `^${prefix}_${ULID_REGEX.source.slice(1, -1)}$` }];
    return (schema.def.checks ?? []).flatMap((check) => {
      const def = check._zod.def as { pattern?: RegExp };
      const pattern = def.pattern?.source;
      return pattern && Object.values(ID_PREFIXES).some((p) => pattern.startsWith(`^${p}-`))
        ? [{ path, pattern }]
        : [];
    });
  }
  if (schema instanceof z.ZodObject)
    return Object.entries(schema.shape).flatMap(([name, field]) =>
      identifierPatterns(field as z.ZodType, [...path, 'properties', name]),
    );
  if (schema instanceof z.ZodUnion)
    return schema.options.flatMap((branch, index) =>
      identifierPatterns(branch as z.ZodType, [...path, 'anyOf', index]),
    );
  if (schema instanceof z.ZodArray)
    return identifierPatterns(schema.element as z.ZodType, [...path, 'items']);
  if (schema instanceof z.ZodRecord)
    return identifierPatterns(schema.valueType as z.ZodType, [...path, 'additionalProperties']);
  if (schema instanceof z.ZodPipe)
    return identifierPatterns(
      (schema.in instanceof z.ZodTransform ? schema.out : schema.in) as z.ZodType,
      path,
    );
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodReadonly
  )
    return identifierPatterns(schema.unwrap() as z.ZodType, path);
  // An unfamiliar container may hide identifiers. Require the walker to support it instead
  // of treating it as an identifier-free leaf and silently weakening route coverage.
  if (
    ['number', 'boolean', 'enum', 'literal', 'unknown', 'any', 'never', 'transform'].includes(
      schema.def.type,
    )
  )
    return [];
  throw new Error(`Identifier coverage cannot inspect ${schema.def.type} at ${path.join('.')}`);
}

function at(value: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
    value,
  );
}

describe('asset-service publishes every Zod-validated body and query', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await buildDocumentationApp();
    document = buildAssetOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // Query strings are published by #711's `ValidatedQuery` (`parametersOf`), held to their
  // validators by document.spec.ts; the converter is not applied to this service (PM, #710 sync).
  it('publishes each route body from its schema, with no exception', () => {
    const inputs = zodRouteInputs(app).filter((input) => input.kind === 'body');
    expect(inputs.length).toBeGreaterThan(0);
    expect(zodRouteInputProblems(document, inputs)).toEqual([]);
  });

  it('publishes `q` without the bounds its validator applies only after `.trim()` (FU-120)', () => {
    // `z.string().trim().min(1).max(100)`: the bounds hold for the trimmed text, not the raw
    // query a JSON Schema validator checks, so publishing them would refuse what the runtime
    // accepts. Fails if the converter (which still publishes them) writes asset queries again.
    const q = document.paths['/v1/assets']?.get?.parameters?.find(
      (p) => 'in' in p && p.in === 'query' && p.name === 'q',
    ) as { schema?: Record<string, unknown> } | undefined;
    expect(q?.schema).toEqual({ type: 'string' });
    expect(q?.schema).not.toHaveProperty('minLength');
    expect(q?.schema).not.toHaveProperty('maxLength');
  });

  it('publishes every prefixed and seed identifier pattern discovered from the routes', () => {
    let checked = 0;
    for (const input of zodRouteInputs(app)) {
      const patterns = identifierPatterns(input.schema);
      if (patterns.length === 0) continue;
      const id = `${input.controller}_${input.handler}`;
      const operations = Object.values(document.paths)
        .flatMap((item) => Object.values(item ?? {}))
        .filter((op): op is OperationObject => {
          if (typeof op !== 'object' || typeof op?.operationId !== 'string') return false;
          return (
            op.operationId === id ||
            (op.operationId.startsWith(id) && /^_v[^_]+$/.test(op.operationId.slice(id.length)))
          );
        });
      expect(operations).toHaveLength(1);
      const operation = operations[0]!;
      const published =
        input.kind === 'body'
          ? at(operation.requestBody, ['content', 'application/json', 'schema'])
          : {
              properties: Object.fromEntries(
                (operation.parameters ?? []).flatMap((p) =>
                  'in' in p && p.in === 'query' ? [[p.name, p.schema]] : [],
                ),
              ),
            };
      for (const { path, pattern } of patterns) {
        const route = zodRouteInputKey(input);
        expect({ route, path, pattern: at(published, [...path, 'pattern']) }).toEqual({
          route,
          path,
          pattern,
        });
        expect(new RegExp(pattern).test('not-an-id')).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each([
    ['/v1/assets/{id}/transfer', 'toOrganizationId', 'ORG'],
    ['/v1/assets/{id}/insurance-claims', 'policyId', 'INS'],
  ])('%s publishes the identifier accepted by the runtime', (path, field, prefix) => {
    const schema = at(document.paths[path]?.post?.requestBody, [
      'content',
      'application/json',
      'schema',
      'properties',
      field,
    ]) as { anyOf: { pattern: string }[] };
    expect(schema.anyOf).toHaveLength(2);
    const accepts = (value: string): boolean =>
      schema.anyOf.some((s) => new RegExp(s.pattern).test(value));
    expect(accepts(`${prefix}_01JBQ0000000000000000000AB`)).toBe(true);
    expect(accepts(`${prefix}-SEED`)).toBe(true);
    expect(accepts('not-an-id')).toBe(false);
    expect(accepts(`${prefix}_IIIIIIIIIIIIIIIIIIIIIIIIII`)).toBe(false);
  });
});
