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
  const explicit =
    operation?.responses?.[String(status)] ??
    operation?.responses?.[`${Math.floor(status / 100)}XX`];
  // OpenAPI's default response is JSON metadata, not Zod's unparsed default() method.
  // eslint-disable-next-line zod/no-default
  const response = explicit ?? operation?.responses?.default;
  const schema = response?.content?.['application/json']?.schema;
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

const METHODS = new Set(['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace']);
const ERROR_REF = { $ref: '#/components/schemas/ApiError' };

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
        if (status !== 'default' && !/^[45][0-9X]{2}$/.test(status)) continue;
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
  const valuesOf = (property?: Schema): string[] =>
    property && 'const' in property
      ? [String(property.const)]
      : ((property?.enum as string[] | undefined) ?? []);
  const variants = (item?.anyOf as Schema[] | undefined) ?? [item];
  return variants.flatMap((variant) => {
    const properties = variant?.properties as Record<string, Schema> | undefined;
    const codes = valuesOf(properties?.code);
    return valuesOf(properties?.path).flatMap((area) => codes.map((code) => ({ area, code })));
  });
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
    const answered = status === 'default' ? [400, 500] : [Number(status.replaceAll('X', '0'))];
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

export interface PublishedProbeException {
  service: string;
  path: string;
  status: 503;
  /** Raw bodies returned by the real probe controller, not hand-written fixtures. */
  bodies: readonly unknown[];
}

export interface ProbeExceptionOptions extends EnvelopeOptions {
  /**
   * The document the routes themselves declare (Nest's document before `publishApiErrors`). A
   * response may carry a schema other than the shared envelope only where its route declared that
   * very schema — a typed refusal (FU-031); without it, only the shared envelope is accepted.
   */
  declared?: PublishedDocument;
}

/** D-121: explicit exceptions only; every other response must name the shared envelope. */
export function probeExceptionProblems(
  document: PublishedDocument,
  service: string,
  exceptions: readonly PublishedProbeException[],
  options: ProbeExceptionOptions = {},
): string[] {
  const problems = errorEnvelopeProblems(document, options);
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method)) continue;
      if (
        !Object.hasOwn(
          (operation as { responses?: Record<string, unknown> }).responses ?? {},
          'default',
        )
      ) {
        problems.push(`${method.toUpperCase()} ${path}: no default error response`);
      }
    }
  }
  const expected = new Map(exceptions.map((entry) => [`GET ${entry.path} ${entry.status}`, entry]));
  if (expected.size !== exceptions.length) problems.push('duplicate probe exception');
  for (const entry of exceptions) {
    if (entry.service !== service)
      problems.push(`exception belongs to ${entry.service}, not ${service}`);
    if (!entry.bodies.length) problems.push(`${entry.path}: no real probe bodies`);
  }
  for (const { operation, status, schema } of publishedErrorResponses(document)) {
    const at = `${operation} ${status}`;
    const exception = expected.get(at);
    if (!exception) {
      const routes = options.declared;
      const declared = routes ? declaredErrorSchema(routes, operation, status) : undefined;
      const plain = JSON.stringify(schema) === JSON.stringify(ERROR_REF);
      const typed =
        routes !== undefined &&
        declared !== undefined &&
        schema !== undefined &&
        sameSchema(routes, declared, document, schema);
      if (!plain && !typed) {
        problems.push(`${at}: does not use the shared envelope`);
      }
      continue;
    }
    expected.delete(at);
    const variants = schema?.anyOf as Schema[] | undefined;
    const health = variants?.[1];
    if (
      variants?.length !== 2 ||
      variants[0]?.$ref !== '#/components/schemas/ApiError' ||
      typeof health?.description !== 'string' ||
      !health.description.includes('D-121')
    ) {
      problems.push(`${at}: missing explicit health schema and exception reason`);
      continue;
    }
    for (const body of exception.bodies) {
      for (const problem of validatePublishedBody(document, health, body)) {
        problems.push(`${at}: ${problem}`);
      }
      const record = body as Record<string, unknown>;
      if (
        !validatePublishedBody(document, health, { ...record, injected: true }).length ||
        !validatePublishedBody(document, health, {}).length
      ) {
        problems.push(`${at}: health schema is not closed`);
      }
    }
  }
  for (const at of expected.keys()) problems.push(`${at}: exception has no published response`);
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
  response: {
    method: string;
    url: string;
    status: number;
    body: unknown;
    traced: boolean;
    /** The route's own template when known; otherwise matched from `url`. */
    template?: string;
  },
): string[] {
  const at = `${response.method} ${response.url} ${response.status}`;
  const path = response.template ?? publishedPathOf(document, response.url);
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

// ---- the real routes (FU-031) ---------------------------------------------------------------

const SCHEMA_REF = '#/components/schemas/';

/** Every component reference reachable from `schema` that `document` does not define. */
export function unresolvedRefs(document: PublishedDocument, schema: unknown): string[] {
  const missing: string[] = [];
  walkRefs(document, schema, new Set(), missing);
  return missing;
}

/** Visits every `$ref` under `value`, following each into its component once. */
function walkRefs(
  document: PublishedDocument,
  value: unknown,
  seen: Set<string>,
  missing: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkRefs(document, item, seen, missing);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, member] of Object.entries(value)) {
    if (key !== '$ref') {
      walkRefs(document, member, seen, missing);
      continue;
    }
    if (typeof member !== 'string' || !member.startsWith(SCHEMA_REF)) {
      missing.push(String(member));
      continue;
    }
    if (seen.has(member)) continue;
    seen.add(member);
    const target = document.components?.schemas?.[member.slice(SCHEMA_REF.length)];
    if (target === undefined) missing.push(member);
    else walkRefs(document, target, seen, missing);
  }
}

/**
 * Whether `a` (in `aDocument`) and `b` (in `bDocument`) are the same schema: the same JSON, and every
 * component either reaches the same JSON in both documents. An unresolved reference is never "same".
 */
function sameSchema(
  aDocument: PublishedDocument,
  a: Schema,
  bDocument: PublishedDocument,
  b: Schema,
): boolean {
  if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  const seen = new Set<string>();
  const missing: string[] = [];
  walkRefs(aDocument, a, seen, missing);
  if (missing.length || unresolvedRefs(bDocument, b).length) return false;
  return [...seen].every((ref) => {
    const name = ref.slice(SCHEMA_REF.length);
    return (
      JSON.stringify(aDocument.components?.schemas?.[name]) ===
      JSON.stringify(bDocument.components?.schemas?.[name])
    );
  });
}

/** The JSON schema `document` gives `operation` (`GET /path`) at exactly `status`. */
function declaredErrorSchema(
  document: PublishedDocument,
  operation: string,
  status: string,
): Schema | undefined {
  return publishedErrorResponses(document).find(
    (entry) => entry.operation === operation && entry.status === status,
  )?.schema;
}

/** Every `METHOD /path` the document publishes an operation for. */
function publishedOperations(document: PublishedDocument): Set<string> {
  const found = new Set<string>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(item as Record<string, unknown>)) {
      if (METHODS.has(method)) found.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return found;
}

/** One route the running application really serves; `path` in OpenAPI form (`/things/{id}`). */
export interface RealRoute {
  method: string;
  path: string;
}

/** What `routeErrorProblems` needs of a Nest application. */
export interface RoutedApplication {
  getHttpAdapter(): { getInstance(): unknown };
}

interface RouterLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
}

/**
 * The routes the application's Express router really holds — what a client can reach, not what
 * the document says. Throws when the router cannot be read or a route path is not one this check
 * understands (an optional `{…}` group, a pattern): an unread route is never assumed absent.
 */
export function realRoutesOf(app: RoutedApplication): RealRoute[] {
  const instance = app.getHttpAdapter().getInstance() as
    { router?: { stack?: unknown }; _router?: { stack?: unknown } } | undefined;
  // Express 5 exposes `router`; Express 4 `_router`.
  const stack = instance?.router?.stack ?? instance?._router?.stack;
  if (!Array.isArray(stack)) throw new Error('the application routes cannot be read');
  const routes: RealRoute[] = [];
  for (const layer of stack as RouterLayer[]) {
    if (!layer.route) continue;
    const { path, methods } = layer.route;
    if (typeof path !== 'string' || /[{}()?+]/.test(path) || !methods) {
      throw new Error(`the route ${String(path)} cannot be resolved`);
    }
    const template = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    for (const [method, enabled] of Object.entries(methods)) {
      if (!enabled) continue;
      routes.push({ method: method === '_all' ? 'ALL' : method.toUpperCase(), path: template });
    }
  }
  if (routes.length === 0) throw new Error('the application serves no route');
  return routes;
}

/**
 * Whether `body` is a D-121 health-status body at a published probe exception: not an envelope
 * (no `path`, `traceId` or `code`), and accepted by the exception's explicit health schema — never
 * by the envelope. Anything else is held to the envelope checks of `httpErrorBodyProblems`.
 */
function isProbeExceptionBody(
  document: PublishedDocument,
  route: RealRoute,
  status: number,
  body: unknown,
): boolean {
  const variants = publishedErrorResponses(document).find(
    (entry) =>
      entry.operation === `${route.method} ${route.path}` && entry.status === String(status),
  )?.schema?.anyOf as Schema[] | undefined;
  const health = variants?.find(
    (variant) => typeof variant.description === 'string' && variant.description.includes('D-121'),
  );
  return (
    health !== undefined &&
    validatePublishedBody(document, health, body).length === 0 &&
    validatePublishedBody(document, ERROR_REF, body).length > 0
  );
}

/** A path parameter value no route treats specially. */
const PROBE_ID = '01JD0000000000000000000000';

export interface RouteCheckOptions extends EnvelopeOptions {
  /** The document the routes declare: Nest's document before `publishApiErrors`. */
  declared: PublishedDocument;
  /** Real route paths deliberately left out of the document, each with its reason. */
  excluded?: Readonly<Record<string, string>>;
  /** Sends one request (no body, no credentials) through the real application. */
  send: (method: string, url: string) => Promise<{ status: number; body: unknown }>;
}

/**
 * The problems found when the routes the application **really serves** are held against the
 * published document (FU-031) — the check reads the router and the routes' answers, not only the
 * document:
 *   - every real route is published, unless excluded with a reason; every published operation is
 *     a real route; an exclusion no route needs, or an excluded route that is published, fails;
 *   - the routes' declared document and the published one have the same operations, and every
 *     error body a route declares (a typed refusal) is published unchanged, not erased;
 *   - every published route is sent one request, and each error it answers is validated, raw,
 *     against the schema the document publishes for that route and status;
 *   - `errorEnvelopeProblems` over the published document.
 * Anything it cannot read — the router, a route path, a reference, a request that gets no
 * answer — is a problem, never skipped.
 */
export async function routeErrorProblems(
  app: RoutedApplication,
  document: PublishedDocument,
  options: RouteCheckOptions,
): Promise<string[]> {
  let routes: RealRoute[];
  try {
    routes = realRoutesOf(app);
  } catch (error) {
    return [(error as Error).message];
  }
  const problems: string[] = [];
  const published = publishedOperations(document);
  const excluded = new Map(Object.entries(options.excluded ?? {}));
  const unusedExclusions = new Set(excluded.keys());
  for (const [path, reason] of excluded) {
    if (!reason.trim()) problems.push(`${path}: excluded without a reason`);
  }

  const served = new Set<string>();
  const probes: RealRoute[] = [];
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (excluded.has(route.path)) {
      unusedExclusions.delete(route.path);
      if (published.has(key)) problems.push(`${key}: excluded but published`);
      continue;
    }
    served.add(key);
    if (!published.has(key)) problems.push(`${key}: served but not published`);
    else probes.push(route);
  }
  for (const path of unusedExclusions) problems.push(`${path}: excluded but no route serves it`);
  for (const key of published) {
    if (!served.has(key)) problems.push(`${key}: published but no route serves it`);
  }

  const declared = publishedOperations(options.declared);
  for (const key of declared) {
    if (!published.has(key)) problems.push(`${key}: declared by its route but not published`);
  }
  for (const key of published) {
    if (!declared.has(key)) problems.push(`${key}: published but not declared by any route`);
  }
  for (const { operation, status, schema } of publishedErrorResponses(options.declared)) {
    if (!schema) continue; // nothing declared: the publisher supplies the shared envelope
    const at = `${operation} ${status}`;
    const missing = unresolvedRefs(options.declared, schema);
    if (missing.length) {
      problems.push(`${at}: the route declares an unresolved ${missing.join(', ')}`);
      continue;
    }
    const kept = declaredErrorSchema(document, operation, status);
    if (!kept || !sameSchema(options.declared, schema, document, kept)) {
      problems.push(`${at}: the error body the route declares is not the one published`);
    }
  }

  let answered = 0;
  for (const route of probes) {
    const url = route.path.replaceAll(/\{[^}]+\}/g, PROBE_ID);
    let sent: { status: number; body: unknown };
    try {
      sent = await options.send(route.method, url);
    } catch (error) {
      problems.push(`${route.method} ${url}: no answer (${(error as Error).message})`);
      continue;
    }
    if (sent.status < 400) continue;
    answered += 1;
    if (isProbeExceptionBody(document, route, sent.status, sent.body)) continue;
    problems.push(
      ...httpErrorBodyProblems(document, {
        method: route.method,
        url,
        status: sent.status,
        body: sent.body,
        traced: false,
        template: route.path,
      }),
    );
  }
  if (answered === 0) problems.push('no real route answered with an error body');

  problems.push(...errorEnvelopeProblems(document, options));
  return problems;
}
