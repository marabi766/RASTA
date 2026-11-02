import { BadRequestException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { z } from 'zod';
import { ERROR_STATUS, type ErrorCode } from '@rasta/contracts';
import type { Logger } from '@rasta/logging';
import { runWithContext, type RequestContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';
import { AllExceptionsFilter } from '../filters/exception.filter';
import { validateRequestInput } from '../pipes/zod-validation.pipe';

/**
 * Conformance of a service's **published** OpenAPI document to the error bodies the platform really
 * sends (audit 10-26 F3). For tests only — nothing at runtime reads it.
 *
 * Validates a real response body against the schema the published document gives for that
 * operation and status (PR-327 r1 F3) — the JSON a client's validator reads, not the Zod source it
 * was generated from.
 *
 * Only the keywords `toJsonSchema` emits are understood, and any other keyword is an error rather
 * than ignored: a validator that skipped what it did not know would accept a body the document
 * refuses. (ajv is a root devDependency only; services declare what they import.)
 */
/** The part of an OpenAPI document these checks read; Nest's `OpenAPIObject` satisfies it. */
export interface PublishedDocument {
  paths?: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}

export type PublishedSchema = Record<string, unknown>;
type Schema = PublishedSchema;

const KNOWN = new Set([
  '$ref',
  'type',
  'nullable',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'description',
]);

/** ISO 8601 instant as `Date#toISOString` writes it and `isoDateTime()` (@rasta/contracts) accepts it. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function publishedResponseSchemaOf(
  document: PublishedDocument,
  method: string,
  path: string,
  status: number,
): Schema {
  const operation = (document.paths?.[path] as Record<string, unknown> | undefined)?.[
    method.toLowerCase()
  ] as { responses?: Record<string, { content?: Record<string, { schema?: Schema }> }> };
  const schema = operation?.responses?.[String(status)]?.content?.['application/json']?.schema;
  if (!schema) throw new Error(`${method} ${path} documents no JSON body for ${status}`);
  return schema;
}

/** The problems of `value` under `schema`; empty when it is accepted. */
export function validatePublishedBody(
  document: PublishedDocument,
  schema: Schema,
  value: unknown,
): string[] {
  const problems: string[] = [];
  check(document, schema, value, '$', problems);
  return problems;
}

function check(
  document: PublishedDocument,
  schema: Schema,
  value: unknown,
  at: string,
  problems: string[],
): void {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) throw new Error(`${at}: schema keyword ${keyword} is not understood`);
  }
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/components/schemas/', '');
    const target = document.components?.schemas?.[name] as Schema | undefined;
    if (!target) throw new Error(`${at}: unresolved ${schema.$ref}`);
    check(document, target, value, at, problems);
    return;
  }
  if (value === null && schema.nullable === true) return;
  if (Array.isArray(schema.anyOf)) {
    const accepted = (schema.anyOf as Schema[]).some(
      (option) => validatePublishedBody(document, option, value).length === 0,
    );
    if (!accepted) problems.push(`${at}: matches no anyOf option`);
    return;
  }
  if ('const' in schema && value !== schema.const) {
    problems.push(`${at}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  switch (schema.type) {
    case undefined:
      return;
    case 'string':
      if (typeof value !== 'string') {
        problems.push(`${at}: not a string`);
        return;
      }
      if (schema.format === 'date-time' && !DATE_TIME.test(value)) {
        problems.push(`${at}: not a date-time`);
      } else if (schema.format !== undefined && schema.format !== 'date-time') {
        throw new Error(`${at}: format ${String(schema.format)} is not understood`);
      }
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
        problems.push(`${at}: shorter than ${schema.minLength}`);
      }
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
        problems.push(`${at}: longer than ${schema.maxLength}`);
      }
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
        problems.push(`${at}: does not match ${schema.pattern}`);
      }
      return;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (schema.type === 'integer' && !Number.isInteger(value))) {
        problems.push(`${at}: not ${String(schema.type)}`);
        return;
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        problems.push(`${at}: below ${schema.minimum}`);
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        problems.push(`${at}: above ${schema.maximum}`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${at}: not a boolean`);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${at}: not an array`);
        return;
      }
      value.forEach((item, index) =>
        check(document, (schema.items ?? {}) as Schema, item, `${at}[${index}]`, problems),
      );
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push(`${at}: not an object`);
        return;
      }
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const name of (schema.required ?? []) as string[]) {
        if (!(name in record)) problems.push(`${at}.${name}: required`);
      }
      for (const [name, member] of Object.entries(record)) {
        const property = properties[name];
        if (property) check(document, property, member, `${at}.${name}`, problems);
        else if (schema.additionalProperties === false) {
          problems.push(`${at}.${name}: not allowed`);
        }
      }
      return;
    }
    default:
      throw new Error(`${at}: type ${String(schema.type)} is not understood`);
  }
}

// ---- the error envelope ---------------------------------------------------------------------

const METHODS = new Set(['get', 'put', 'post', 'patch', 'delete', 'head', 'options']);

export interface PublishedErrorResponse {
  /** `POST /v1/things`. */
  operation: string;
  /** `404`, or `default`. */
  status: string;
  /** Absent when the response documents no JSON body. */
  schema?: Schema;
}

/** Every error response (4xx, 5xx, `default`) every operation of the document publishes. */
export function publishedErrorResponses(document: PublishedDocument): PublishedErrorResponse[] {
  const found: PublishedErrorResponse[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method)) continue;
      const responses = (operation as { responses?: Record<string, unknown> }).responses ?? {};
      for (const [status, response] of Object.entries(responses)) {
        if (status !== 'default' && !(Number(status) >= 400)) continue;
        const schema = (response as { content?: Record<string, { schema?: Schema }> }).content?.[
          'application/json'
        ]?.schema;
        found.push({ operation: `${method.toUpperCase()} ${path}`, status, schema });
      }
    }
  }
  return found;
}

/** What the request context of the failing request held. */
export interface ProbeContext {
  correlationId: string;
  traceId?: string;
  path?: string;
}

/** The three shapes the filter's optional fields take: both known, neither known, no context at all. */
export const PROBE_CONTEXTS: Readonly<Record<string, ProbeContext | undefined>> = {
  'trace and path known': {
    correlationId: '01JD0000000000000000000000',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    path: '/v1/things/THG_01JD0000000000000000000000',
  },
  'neither trace nor path known': { correlationId: 'client-supplied-correlation-id' },
  'no request context': undefined,
};

const NOOP_LOGGER = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

/**
 * The JSON body the **real** `AllExceptionsFilter` writes for `exception`, as a client reads it
 * (serialised and parsed again, nothing stripped).
 */
export function realFilterResponse(
  exception: unknown,
  context?: ProbeContext,
): { status: number; body: unknown } {
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: unknown) => {
      sent.body = JSON.parse(JSON.stringify(body));
    },
    setHeader: () => undefined,
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  const filter = new AllExceptionsFilter(NOOP_LOGGER);
  if (!context) {
    filter.catch(exception, host);
  } else {
    const requestContext: RequestContext = {
      correlationId: context.correlationId,
      requestId: 'probe-request',
      ...(context.traceId ? { traceId: context.traceId } : {}),
      ...(context.path ? { path: context.path } : {}),
      method: 'POST',
      roles: [],
      organizationIds: [],
      authType: 'ANONYMOUS',
      startedAt: 0,
    };
    runWithContext(requestContext, () => filter.catch(exception, host));
  }
  return sent;
}

/** A 400 produced the way a service produces its own: the shared pipe's parse, with typed `details`. */
function validationFailure(): RastaError {
  try {
    validateRequestInput(
      z
        .object({
          quantity: z.number().int().min(1),
          note: z.string().max(3),
          tags: z.array(z.string()).max(1),
        })
        .strict(),
      { quantity: 0, note: 'too long', tags: ['a', 'b'], extra: true },
    );
  } catch (error) {
    return error as RastaError;
  }
  throw new Error('the probe schema accepted its invalid input');
}

/** Real exceptions whose answer has `status`: what the platform throws for it, not a hand-made body. */
function exceptionsAnswering(status: number): { name: string; exception: unknown }[] {
  if (status === 400) {
    return [
      {
        name: 'VALIDATION_FAILED through the shared validation pipe',
        exception: validationFailure(),
      },
      { name: 'a malformed body', exception: new BadRequestException('Unexpected token') },
    ];
  }
  const code = (Object.keys(ERROR_STATUS) as ErrorCode[]).find((c) => ERROR_STATUS[c] === status);
  return [
    {
      name: code ?? `HTTP ${status}`,
      exception: code ? new RastaError(code, 'Refused') : new HttpException('Refused', status),
    },
  ];
}

/**
 * Every `(area, code)` a typed refusal schema lists in `details[]`: `path` the area, `code` the
 * reason — what `toJsonSchema` makes of `z.literal(area)` and `z.enum(codes)`. Empty for the plain
 * envelope, whose `path` and `code` are free strings.
 */
function listedReasons(schema: Schema): { area: string; code: string }[] {
  const item = (schema.properties as Record<string, Schema> | undefined)?.details?.items as
    Schema | undefined;
  const properties = item?.properties as Record<string, Schema> | undefined;
  const valuesOf = (property?: Schema): string[] =>
    property && 'const' in property
      ? [String(property.const)]
      : ((property?.enum as string[] | undefined) ?? []);
  const codes = valuesOf(properties?.code);
  return valuesOf(properties?.path).flatMap((area) => codes.map((code) => ({ area, code })));
}

export interface EnvelopeOptions {
  /**
   * The service's own refusal for a closed reason (`refusal(area, reason, message)`), for a
   * document that types `details` per area. Called once per `(area, code)` a response lists; the
   * exception is thrown through the real filter and its body must be accepted.
   */
  refusal?: (area: string, code: string) => RastaError;
}

/**
 * The problems found when the real error bodies are held against the published document; empty when
 * the document accepts what the platform sends and still refuses what it does not.
 *
 * For every error response of every operation:
 *   - the body the real filter writes for an exception of that status — a validation failure
 *     through the shared pipe for 400 — with the request context holding trace and path, holding
 *     neither, and absent altogether, must be accepted (a field the filter adds that the document
 *     forbids fails here);
 *   - for a response that types `details` per area, the body of each listed `(area, code)` through
 *     `options.refusal` must be accepted, under the status the document lists it for;
 *   - the same body with a field the platform never sends must be refused, and so must one without
 *     `timestamp` — a document that was opened, or lost a required field, fails here.
 */
export function errorEnvelopeProblems(
  document: PublishedDocument,
  options: EnvelopeOptions = {},
): string[] {
  const problems: string[] = [];
  const responses = publishedErrorResponses(document);
  if (responses.length === 0) return ['the document publishes no error response'];

  for (const { operation, status, schema } of responses) {
    const at = `${operation} ${status}`;
    if (!schema) {
      problems.push(`${at}: documents no JSON body`);
      continue;
    }
    const answered = status === 'default' ? [400, 500] : [Number(status)];
    const probes: { name: string; exception: unknown }[] = answered.flatMap(exceptionsAnswering);

    for (const { area, code } of listedReasons(resolve(document, schema))) {
      if (!options.refusal) {
        problems.push(`${at}: lists ${area}/${code} but no refusal producer was given`);
        continue;
      }
      const exception = options.refusal(area, code);
      if (String(exception.status) !== status) {
        problems.push(`${at}: ${area}/${code} is answered ${exception.status}, not ${status}`);
      }
      probes.push({ name: `refusal ${area}/${code}`, exception });
    }

    for (const { name, exception } of probes) {
      for (const [contextName, context] of Object.entries(PROBE_CONTEXTS)) {
        const { body } = realFilterResponse(exception, context);
        const label = `${at}, ${name}, ${contextName}`;
        for (const problem of validatePublishedBody(document, schema, body)) {
          problems.push(`${label}: ${problem}`);
        }
        const record = body as Record<string, unknown>;
        if (validatePublishedBody(document, schema, { ...record, injected: 'x' }).length === 0) {
          problems.push(`${label}: a field the platform never sends was accepted`);
        }
        const { timestamp: _timestamp, ...withoutTimestamp } = record;
        if (validatePublishedBody(document, schema, withoutTimestamp).length === 0) {
          problems.push(`${label}: a body without timestamp was accepted`);
        }
      }
    }
  }
  return problems;
}

function resolve(document: PublishedDocument, schema: Schema): Schema {
  if (typeof schema.$ref !== 'string') return schema;
  const target = document.components?.schemas?.[schema.$ref.replace('#/components/schemas/', '')];
  if (!target) throw new Error(`unresolved ${schema.$ref}`);
  return target as Schema;
}

/** A W3C `traceparent` header value; the request context middleware reads `traceId` from it. */
export const PROBE_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/**
 * The path of the document `url` is served by: the template whose placeholders (`{id}`) match the
 * segments of `url`, the one with the fewest placeholders when several do (`/stock/reservations`
 * before `/stock/{id}`). The query string is ignored.
 */
export function publishedPathOf(document: PublishedDocument, url: string): string | undefined {
  const path = url.split('?')[0]!;
  const matches = Object.keys(document.paths ?? {})
    .filter((template) => {
      const parts = template.split('/');
      const actual = path.split('/');
      return (
        parts.length === actual.length &&
        parts.every((part, index) =>
          part.startsWith('{') ? !!actual[index] : part === actual[index],
        )
      );
    })
    .sort((x, y) => (x.match(/\{/g)?.length ?? 0) - (y.match(/\{/g)?.length ?? 0));
  return matches[0];
}

/**
 * The problems of one error response a **real application** answered over HTTP, held against the
 * schema the document publishes for that operation and status — raw body, nothing stripped.
 * `url` is what was requested (ids and query string included). `traced` says whether the request
 * carried {@link PROBE_TRACEPARENT}: the body then has the `traceId` and without it none, and it
 * always has the `path` the request middleware recorded.
 */
export function httpErrorBodyProblems(
  document: PublishedDocument,
  response: { method: string; url: string; status: number; body: unknown; traced: boolean },
): string[] {
  const at = `${response.method} ${response.url} ${response.status}`;
  const path = publishedPathOf(document, response.url);
  if (!path) return [`${at}: the document publishes no such route`];
  let schema: Schema;
  try {
    schema = publishedResponseSchemaOf(document, response.method, path, response.status);
  } catch (error) {
    return [`${at}: ${(error as Error).message}`];
  }
  const problems = validatePublishedBody(document, schema, response.body).map(
    (problem) => `${at}: ${problem}`,
  );
  const body = (response.body ?? {}) as Record<string, unknown>;
  if (response.traced && body.traceId !== '4bf92f3577b34da6a3ce929d0e0e4736') {
    problems.push(`${at}: the traceparent sent did not come back as traceId`);
  }
  if (!response.traced && 'traceId' in body) problems.push(`${at}: traceId without a traceparent`);
  if (typeof body.path !== 'string' || !body.path.startsWith('/')) {
    problems.push(`${at}: no path`);
  }
  return problems;
}
