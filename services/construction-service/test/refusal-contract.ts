import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { buildConstructionOpenApiDocument } from '../src/openapi/document';
import { recordRoutes } from './refusal-coverage';

/**
 * The refusals the integration suites really cause, checked against the contract the service
 * publishes (docs/06 § 6.7).
 *
 * The recorder sits in front of the real application (see `startApi`): every 403, 409 and 422
 * a suite provokes is kept with its route and body. When the harness closes, each is validated
 * against the **generated OpenAPI document's** schema for that route and status — the same
 * document `docs/api/construction-service.openapi.json` is byte-compared with — so a refusal
 * the document does not describe (a path or a code it does not list) fails the suite that
 * provoked it. The routes that answered a closed reason are kept (`refusal-coverage.ts`) so that the run's
 * global teardown can require every route of `REFUSAL_REASONS` to have been seen.
 */

export interface RecordedRefusal {
  /** `METHOD /v1/path/{param}`, the key of `REFUSAL_REASONS`. */
  readonly key: string;
  readonly status: number;
  readonly body: unknown;
}

const REFUSAL_STATUSES = new Set([403, 409, 422]);

export interface RefusalRecorder {
  readonly recorded: RecordedRefusal[];
}

/** Install before `app.init()`; the middleware only observes, it changes nothing in the answer. */
export function recordRefusals(app: INestApplication): RefusalRecorder {
  const recorded: RecordedRefusal[] = [];
  app.use((request: Request, response: Response, next: NextFunction) => {
    const json = response.json.bind(response) as (body?: unknown) => Response;
    response.json = ((body?: unknown) => {
      const route = (request.route as { path?: unknown } | undefined)?.path;
      if (REFUSAL_STATUSES.has(response.statusCode) && typeof route === 'string') {
        recorded.push({
          key: `${request.method.toUpperCase()} ${route.replace(/:(\w+)/g, '{$1}')}`,
          status: response.statusCode,
          body,
        });
      }
      return json(body);
    }) as Response['json'];
    next();
  });
  return { recorded };
}

type Schema = Record<string, unknown>;

/**
 * A validator for the JSON Schema subset the generated document uses: `$ref` into components,
 * `type`, `properties`/`required`/`additionalProperties`, `items`, `anyOf`, `const`, `enum`.
 * Anything else in a schema is refused rather than ignored, so the validator cannot quietly
 * accept a shape it does not understand.
 */
const KNOWN_KEYWORDS = new Set([
  '$ref',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'const',
  'enum',
  'description',
]);

export function validate(
  document: OpenAPIObject,
  schema: Schema,
  value: unknown,
  at = '$',
): string[] {
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    const target = (document.components?.schemas as Record<string, Schema> | undefined)?.[name];
    return target ? validate(document, target, value, at) : [`${at}: unresolved ${ref}`];
  }
  const unknown = Object.keys(schema).filter((keyword) => !KNOWN_KEYWORDS.has(keyword));
  if (unknown.length > 0) return [`${at}: the validator does not know ${unknown.join(', ')}`];

  if (Array.isArray(schema.anyOf)) {
    const attempts = (schema.anyOf as Schema[]).map((option) =>
      validate(document, option, value, at),
    );
    return attempts.some((errors) => errors.length === 0)
      ? []
      : [`${at}: matches none of the documented shapes (${attempts.flat().join('; ')})`];
  }
  if ('const' in schema && value !== schema.const) {
    return [`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`];
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    return [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }

  const errors: string[] = [];
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') errors.push(`${at}: not a string`);
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${at}: not an array`];
      value.forEach((item, index) =>
        errors.push(...validate(document, (schema.items ?? {}) as Schema, item, `${at}[${index}]`)),
      );
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${at}: not an object`];
      }
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const record = value as Record<string, unknown>;
      for (const name of (schema.required ?? []) as string[]) {
        if (!(name in record)) errors.push(`${at}.${name}: required`);
      }
      for (const [name, item] of Object.entries(record)) {
        const declared = properties[name];
        if (declared) errors.push(...validate(document, declared, item, `${at}.${name}`));
        else if (schema.additionalProperties === false)
          errors.push(`${at}.${name}: not documented`);
      }
      break;
    }
    case undefined:
      break;
    default:
      errors.push(`${at}: the validator does not know type ${String(schema.type)}`);
  }
  return errors;
}

/** The documented body schema of a route's status, or `undefined` when the route or status is not documented. */
export function responseSchemaOf(
  document: OpenAPIObject,
  key: string,
  status: number,
): Schema | undefined {
  const [method, path] = key.split(' ') as [string, string];
  const operation = (document.paths?.[path] as Record<string, unknown> | undefined)?.[
    method.toLowerCase()
  ] as { responses?: Record<string, unknown> } | undefined;
  const response = operation?.responses?.[String(status)] as
    { content?: { 'application/json'?: { schema?: Schema } } } | undefined;
  return response?.content?.['application/json']?.schema;
}

/**
 * `AllExceptionsFilter` adds `timestamp` (and `path`) to every error body, and the shared `ApiError`
 * does not document them — an envelope matter older than the closed reasons and not this contract's
 * to settle (reported on #227). They are set aside so that what is checked is the code, the message
 * and `details`, which is what a client branches on.
 */
function withoutEnvelopeExtras(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const { timestamp: _timestamp, path: _path, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** Every recorded refusal that the document does not describe, one line each. */
export function violationsOf(
  app: INestApplication,
  recorded: readonly RecordedRefusal[],
): string[] {
  const document = buildConstructionOpenApiDocument(app);
  const violations: string[] = [];
  for (const refusal of recorded) {
    const schema = responseSchemaOf(document, refusal.key, refusal.status);
    if (!schema) {
      violations.push(`${refusal.key} ${refusal.status}: the document declares no such response`);
      continue;
    }
    for (const error of validate(document, schema, withoutEnvelopeExtras(refusal.body))) {
      violations.push(`${refusal.key} ${refusal.status}: ${error}`);
    }
  }
  return violations;
}

/** Keeps which routes were seen, for the coverage check, and fails on any refusal the contract does not describe. */
export function settleRefusals(app: INestApplication, recorder: RefusalRecorder): void {
  const withDetails = recorder.recorded.filter(
    (refusal) =>
      Array.isArray((refusal.body as { details?: unknown } | null)?.details) &&
      (refusal.body as { details: unknown[] }).details.length > 0,
  );
  recordRoutes(withDetails.map((refusal) => refusal.key));
  const violations = violationsOf(app, recorder.recorded);
  if (violations.length > 0) {
    throw new Error(
      `Refusals the suite provoked that the published OpenAPI document does not describe:\n${[
        ...new Set(violations),
      ].join('\n')}`,
    );
  }
}
