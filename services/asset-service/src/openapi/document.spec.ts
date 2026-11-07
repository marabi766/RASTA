import { type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { type OpenAPIObject } from '@nestjs/swagger';
import { publishedIsoDateTimeZone, WITHOUT_BIDI_CONTROL } from '@rasta/contracts';
import { toJsonSchema, ZodValidationPipe } from '@rasta/nest-common';
import { parametersOf } from './query-parameters';
import { z } from 'zod';
import { buildAssetOpenApiDocument, buildDocumentationApp } from './document';
import {
  activateAssetSchema,
  changeStatusSchema,
  decommissionSchema,
  updateAssetSchema,
  listAssetsQuerySchema,
  nearbyQuerySchema,
} from '../asset/dto';
import { canonicalIdentifier } from '../asset/identifier';

/**
 * The document this service actually serves.
 *
 * Asserted on `buildAssetOpenApiDocument` — the builder `main.ts` serves — rather than on the decorator metadata that feeds it. The
 * defect being fixed here was a published contract that disagreed with the
 * runtime, and only the finished document can show that it no longer does.
 *
 * The providers are stubs because nothing is invoked: building the document
 * reads decorators, not behaviour, so this needs no database and no PostGIS.
 */
async function buildDocument() {
  const app = await buildDocumentationApp();
  try {
    return buildAssetOpenApiDocument(app);
  } finally {
    await app.close();
  }
}

describe('the served OpenAPI document', () => {
  let parameters: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    const document = await buildDocument();
    const operation = document.paths['/v1/assets/nearby']?.get;

    // The route has to be in the document before its parameters can be.
    expect(operation).toBeDefined();

    parameters = Object.fromEntries(
      ((operation?.parameters ?? []) as unknown as Record<string, unknown>[]).map((parameter) => [
        parameter.name as string,
        parameter,
      ]),
    );
  });

  it('publishes availableOnly as a boolean defaulting to false', () => {
    // The contract defect this closes: the parameter's runtime type is
    // `boolean | string`, because that is how a boolean crosses a query
    // string. Published as that union it would read `anyOf: [boolean, string]`
    // — arbitrary strings, to a generated client, when the parser accepts
    // eight spellings and rejects everything else with a 400.
    expect(parameters.availableOnly).toMatchObject({
      name: 'availableOnly',
      in: 'query',
      required: false,
      schema: { type: 'boolean', default: false },
    });
  });

  it('does not offer availableOnly as a string in any form', () => {
    const schema = parameters.availableOnly?.schema as Record<string, unknown>;

    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('string');
  });

  it('FU-131 publishes numeric transport types and bounds from the inner schema', () => {
    expect(
      nearbyQuerySchema.safeParse({ latitude: '', longitude: '', limit: '0x10' }).success,
    ).toBe(false);
    const ranges = {
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
      radiusMeters: { type: 'integer', minimum: 1, maximum: 500_000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    };
    for (const name of ['latitude', 'longitude', 'radiusMeters', 'limit'] as const) {
      const field = nearbyQuerySchema.shape[name];
      const body = toJsonSchema(z.object({ [name]: field })).properties as Record<string, unknown>;
      expect(parameters[name]?.schema).toEqual(body[name]);
      expect(parameters[name]?.schema).toMatchObject(ranges[name]);
      expect(parameters[name]?.required).toBe(name === 'latitude' || name === 'longitude');
    }
    expect(parameters.radiusMeters?.schema).toHaveProperty('default', 50_000);
    expect(parameters.limit?.schema).toHaveProperty('default', 25);
    const expiry = parametersOf(listAssetsQuerySchema).find(
      (p) => 'name' in p && p.name === 'expiringWithinDays',
    );
    const expirySchema = expiry && 'schema' in expiry ? expiry.schema : undefined;
    expect(expirySchema).toEqual(toJsonSchema(listAssetsQuerySchema.shape.expiringWithinDays));
    expect(expirySchema).toMatchObject({ type: 'integer', minimum: 1, maximum: 365 });
    expect(parameters.type).toMatchObject({ required: false, schema: { type: 'string' } });
  });
});

describe('the served PATCH /v1/assets/{id} request body', () => {
  type Body = {
    type: string;
    required?: string[];
    properties: Record<string, { type?: string; minimum?: number; nullable?: boolean }>;
  };
  let body: Body;

  beforeAll(async () => {
    const document = await buildDocument();
    const operation = document.paths['/v1/assets/{id}']?.patch as unknown as {
      requestBody?: { required?: boolean; content: Record<string, { schema: Body }> };
    };
    expect(operation).toBeDefined();
    expect(operation.requestBody).toBeDefined();
    body = operation.requestBody!.content['application/json']!.schema;
  });

  it('says expectedVersion is required, so a generated client cannot omit it', () => {
    expect(body.required).toEqual(['expectedVersion']);
    expect(body.properties.expectedVersion).toMatchObject({ type: 'integer', minimum: 1 });
  });

  it('publishes every field the validator accepts, and nothing it would refuse', () => {
    expect(Object.keys(body.properties).sort()).toEqual(
      Object.keys(updateAssetSchema.shape).sort(),
    );
  });

  it('marks required exactly the fields the validator does not make optional', () => {
    const shape = updateAssetSchema.shape as Record<string, { isOptional(): boolean }>;
    const required = Object.entries(shape)
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name);
    expect(body.required).toEqual(required);
  });

  it('marks a field nullable where the validator accepts null, since null clears it', () => {
    const shape = updateAssetSchema.shape as Record<string, { isNullable(): boolean }>;
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    for (const [name, field] of Object.entries(shape)) {
      if (field.isNullable()) expect(ajv.compile(body.properties[name]!)(null)).toBe(true);
    }
  });
});

describe.each([
  ['activate', '/v1/assets/{id}/activate', activateAssetSchema],
  ['change status', '/v1/assets/{id}/status', changeStatusSchema],
  ['decommission', '/v1/assets/{id}/decommission', decommissionSchema],
] as const)('the served POST %s request body', (_name, path, schema) => {
  type Body = {
    type: string;
    additionalProperties?: boolean;
    required?: string[];
    properties: Record<string, { type?: string; minimum?: number }>;
  };
  let body: Body;

  beforeAll(async () => {
    const document = await buildDocument();
    const operation = document.paths[path]?.post as unknown as {
      requestBody?: { content: Record<string, { schema: Body }> };
    };
    expect(operation?.requestBody).toBeDefined();
    body = operation.requestBody!.content['application/json']!.schema;
  });

  it('says expectedVersion is required, so a generated client cannot omit it', () => {
    expect(body.required).toContain('expectedVersion');
    expect(body.properties.expectedVersion).toMatchObject({ type: 'integer', minimum: 1 });
    expect(body.additionalProperties).toBe(false);
  });

  it('publishes every field the validator accepts, and nothing it would refuse', () => {
    expect(Object.keys(body.properties).sort()).toEqual(Object.keys(schema.shape).sort());
  });

  it('marks required exactly the fields the validator does not make optional', () => {
    const shape = schema.shape as Record<string, { isOptional(): boolean }>;
    const required = Object.entries(shape)
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name);
    expect([...(body.required ?? [])].sort()).toEqual(required.sort());
  });
});

describe('POST /v1/assets in the served document (#169)', () => {
  it('requires the Idempotency-Key header, as the service itself does', async () => {
    const document = await buildDocument();
    const operation = document.paths['/v1/assets']?.post;
    expect(operation).toBeDefined();

    const header = ((operation?.parameters ?? []) as unknown as Record<string, unknown>[]).find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );
    expect(header).toMatchObject({ in: 'header', required: true });
  });
});

describe.each([
  ['/v1/assets/{id}/insurance-policies', 'insurance policy'],
  ['/v1/assets/{id}/inspections', 'technical inspection'],
  ['/v1/assets/{id}/documents', 'document reference'],
])('POST %s in the served document (EXP-002 slices 6 and 7)', (path, _what) => {
  it('requires the Idempotency-Key header, as the service itself does', async () => {
    const document = await buildDocument();
    const operation = document.paths[path]?.post;
    expect(operation).toBeDefined();

    const header = ((operation?.parameters ?? []) as unknown as Record<string, unknown>[]).find(
      (parameter) => parameter.name === 'Idempotency-Key',
    );
    expect(header).toMatchObject({ in: 'header', required: true });
  });

  it('says what a replay returns', async () => {
    const document = await buildDocument();
    const operation = document.paths[path]?.post as { description?: string } | undefined;
    expect(operation?.description).toMatch(/Idempotency-Key/);
  });
});

/**
 * The character rule, published (#220): every published body field whose
 * Zod schema carries a regex publishes that regex's source as its `pattern` —
 * read out of the validator itself, so a published rule that drifts from the
 * one enforced fails here. The fields #220 moved to `plainText()` are named
 * too, so a body that stops publishing them cannot pass by having no regex.
 */
describe('the character rule in the published request bodies', () => {
  /** Every regex source on a Zod field, through optional, nullable and refinement wrappers. */
  function regexSources(field: z.ZodTypeAny): string[] {
    let current: z.ZodTypeAny = field;
    for (;;) {
      if (current instanceof z.ZodOptional || current instanceof z.ZodNullable)
        current = current.unwrap() as z.ZodType;
      // A refinement is a check on the string itself; a transform or preprocess is a pipe. A pipe
      // between two schemas checks the value against both (`identifierText()`'s raw bound, then
      // `plainText()`), so both sides' patterns are the field's.
      else if (current instanceof z.ZodPipe) {
        if (current.in instanceof z.ZodTransform) current = current.out as z.ZodType;
        else if (current.out instanceof z.ZodTransform) current = current.in as z.ZodType;
        else
          return [
            ...regexSources(current.in as z.ZodType),
            ...regexSources(current.out as z.ZodType),
          ];
      } else break;
    }
    if (!(current instanceof z.ZodString)) return [];
    return (current.def.checks ?? []).flatMap((check) => {
      const def = check._zod.def as { check: string; format?: string; pattern?: RegExp };
      // An `isoDateTime()` check enforces its zone, registered beside it and published (FU-035).
      const zone = publishedIsoDateTimeZone(check);
      if (zone) return [zone.pattern];
      return def.check === 'string_format' && def.format === 'regex' && def.pattern
        ? [def.pattern.source]
        : [];
    });
  }

  type Body = { properties: Record<string, { pattern?: string }> };
  let bodies: Record<string, Body>;

  beforeAll(async () => {
    const document = await buildDocument();
    const body = (path: string, method: 'post' | 'patch') =>
      (
        document.paths[path]?.[method] as unknown as {
          requestBody: { content: Record<string, { schema: Body }> };
        }
      ).requestBody.content['application/json']!.schema;
    bodies = {
      update: body('/v1/assets/{id}', 'patch'),
      status: body('/v1/assets/{id}/status', 'post'),
      decommission: body('/v1/assets/{id}/decommission', 'post'),
    };
  });

  it.each([
    ['update', 'model', updateAssetSchema.shape.model],
    ['status', 'reason', changeStatusSchema.shape.reason],
    ['decommission', 'reason', decommissionSchema.shape.reason],
  ] as const)('%s.%s publishes the raw bidi pattern (F3, FU-120)', (body, field, schema) => {
    expect(regexSources(schema)).toEqual([WITHOUT_BIDI_CONTROL.source]);
    expect(schema.safeParse('   ').success).toBe(false);
    expect(bodies[body]!.properties[field]?.pattern).toBe(WITHOUT_BIDI_CONTROL.source);
    expect(bodies[body]!.properties[field]).toHaveProperty(
      'description',
      expect.stringContaining('Constraints after a value-changing step are omitted'),
    );
  });

  it.each([
    ['update', updateAssetSchema.shape],
    ['status', changeStatusSchema.shape],
    ['decommission', decommissionSchema.shape],
  ] as const)('publishes no pattern the %s validator does not enforce', (body, shape) => {
    for (const [name, property] of Object.entries(bodies[body]!.properties)) {
      if (property.pattern === undefined) continue;
      const field = (shape as Record<string, z.ZodTypeAny>)[name]!;
      expect([name, regexSources(field)]).toEqual([name, [property.pattern]]);
    }
  });
});

/**
 * FU-078: every input a route validates is published from the schema that validates it.
 *
 * The validated inputs are enumerated from the application itself — the validating pipe of every
 * `@Body`/`@Query` parameter of every route the documentation module really serves, read out of
 * Nest's route metadata — and independently of what the document publishes. A route that
 * validates a body or query and publishes none fails here (r1 F1: eleven bodies and two queries
 * did); so does one whose published body differs from its validator's converter output, and an
 * input that is read with no validator, or with one this test cannot read, fails closed.
 */
describe('every validated input is published from its validator (FU-078)', () => {
  type Parameter = { name: string; in: string; required?: boolean; schema?: unknown };
  type Operation = {
    operationId?: string;
    requestBody?: { content: Record<string, { schema: unknown }> };
    parameters?: Parameter[];
  };
  type Validated = { handler: string; kind: 'body' | 'query'; schema: z.ZodType };

  let document: OpenAPIObject;
  let validated: Validated[];
  const operations = new Map<string, Operation & { route: string }>();
  /** `METHOD /path` → published body, for the field-level checks below. */
  const bodies: Record<string, unknown> = {};

  beforeAll(async () => {
    const app = await buildDocumentationApp();
    try {
      document = buildAssetOpenApiDocument(app);
      validated = validatedInputs(app);
    } finally {
      await app.close();
    }
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, Operation>)) {
        const route = `${method} ${path}`;
        if (operation?.operationId) operations.set(operation.operationId, { ...operation, route });
        const body = operation?.requestBody?.content['application/json']?.schema;
        if (body !== undefined) bodies[route] = body;
      }
    }
  });

  /** Every `@Body`/`@Query` parameter of every served route, with the schema its pipe validates. */
  function validatedInputs(app: INestApplication): Validated[] {
    const found: Validated[] = [];
    for (const module of app.get(ModulesContainer).values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as { name: string; prototype: object };
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
            string,
            { data?: unknown; pipes?: unknown[] }
          >;
          for (const [key, arg] of Object.entries(args)) {
            const type = Number(key.split(':')[0]);
            if (type !== RouteParamtypes.BODY && type !== RouteParamtypes.QUERY) continue;
            const where = `${controller.name}.${name} ${key}`;
            // Fail closed: an input read whole, by exactly one validator this test can read.
            if (arg.data !== undefined) throw new Error(`${where} reads one field of its input`);
            const zod = (arg.pipes ?? []).filter((pipe) => pipe instanceof ZodValidationPipe);
            if (zod.length !== 1 || arg.pipes?.length !== 1) {
              throw new Error(`${where} is not validated by exactly one ZodValidationPipe`);
            }
            found.push({
              handler: `${controller.name}_${name}`,
              kind: type === RouteParamtypes.BODY ? 'body' : 'query',
              schema: (zod[0] as ZodValidationPipe<z.ZodType>).schema,
            });
          }
        }
      }
    }
    return found;
  }

  function operationOf(handler: string): Operation & { route: string } {
    const operation = operations.get(handler) ?? operations.get(`${handler}_v1`);
    if (!operation) throw new Error(`${handler} validates an input but serves no operation`);
    return operation;
  }

  it('finds every validated input of the real controllers (15 bodies, 3 queries)', () => {
    expect(validated.filter((input) => input.kind === 'body')).toHaveLength(15);
    expect(validated.filter((input) => input.kind === 'query')).toHaveLength(3);
  });

  it('publishes every validated body as its validator, converted', () => {
    const wrong = validated
      .filter((input) => input.kind === 'body')
      .map((input) => {
        const operation = operationOf(input.handler);
        const published = operation.requestBody?.content['application/json']?.schema;
        return { route: operation.route, published, expected: toJsonSchema(input.schema) };
      })
      .filter(({ published, expected }) => !isDeepStrictEqual(published, expected))
      .map(({ route }) => route);
    expect(wrong).toEqual([]);
  });

  it('publishes a body only where one is validated', () => {
    const validatedRoutes = validated
      .filter((input) => input.kind === 'body')
      .map((input) => operationOf(input.handler).route);
    expect(Object.keys(bodies).sort()).toEqual([...validatedRoutes].sort());
  });

  it('publishes every validated query field as a parameter, from its validator', () => {
    for (const input of validated.filter((candidate) => candidate.kind === 'query')) {
      const operation = operationOf(input.handler);
      const published = (operation.parameters ?? []).filter(
        (parameter) => parameter.in === 'query',
      );
      const expected = parametersOf(input.schema as z.ZodObject).map((parameter) => ({
        ...parameter,
        in: 'query',
      }));
      expect([operation.route, sortByName(published)]).toEqual([
        operation.route,
        sortByName(expected as Parameter[]).map((parameter) => expect.objectContaining(parameter)),
      ]);
    }
  });

  function sortByName<T extends { name: string }>(parameters: T[]): T[] {
    return [...parameters].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * FU-078 r1 F2: the published document, compiled by AJV the way a client's validator reads it.
   * PATCH `assetTag` was `{"nullable":true}`, which AJV refuses ("nullable" cannot be used without
   * "type"). Every schema the document carries is compiled, `$ref`s resolved against its components.
   */
  it('compiles under AJV, every schema it carries', () => {
    const base = 'https://asset-service.invalid/components/';
    const resolveRefs = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value), (key, inner: unknown) =>
        key === '$ref' && typeof inner === 'string'
          ? inner.replace('#/components/schemas/', base)
          : inner,
      );
    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    ajv.addVocabulary(['example', 'xml', 'externalDocs']);
    for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
      ajv.addSchema(resolveRefs(schema) as object, `${base}${name}`);
    }
    const failures: string[] = [];
    const compile = (where: string, schema: unknown) => {
      try {
        ajv.compile(resolveRefs(schema) as object);
      } catch (error) {
        failures.push(`${where}: ${(error as Error).message}`);
      }
    };
    for (const name of Object.keys(document.components?.schemas ?? {})) {
      compile(`#/components/schemas/${name}`, { $ref: `${base}${name}` });
    }
    let compiled = 0;
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, Operation>)) {
        const route = `${method} ${path}`;
        const body = operation?.requestBody?.content['application/json']?.schema;
        if (body !== undefined) {
          compile(`${route} body`, body);
          compiled += 1;
        }
        for (const parameter of operation?.parameters ?? []) {
          if (parameter.schema !== undefined)
            compile(`${route} ${parameter.name}`, parameter.schema);
        }
        const responses = (operation as { responses?: Record<string, unknown> })?.responses ?? {};
        for (const [status, response] of Object.entries(responses)) {
          const content = (response as { content?: Record<string, { schema?: unknown }> }).content;
          for (const [type, media] of Object.entries(content ?? {})) {
            if (media.schema !== undefined) compile(`${route} ${status} ${type}`, media.schema);
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(compiled).toBe(15);
  });

  it.each([
    'patch /v1/assets/{id}',
    'post /v1/assets/{id}/activate',
    'post /v1/assets/{id}/status',
    'post /v1/assets/{id}/decommission',
  ])('%s keeps the prose the hand-typed body carried', (operation) => {
    const published = bodies[operation] as {
      properties: Record<string, { description?: string }>;
    };
    expect(published.properties.expectedVersion?.description).toMatch(/OPTIMISTIC_LOCK_FAILED/);
    for (const field of ['model', 'reason'].filter((name) => name in published.properties)) {
      expect(published.properties[field]?.description).toMatch(/Bidi_Control/);
    }
  });

  it('publishes PATCH assetTag as the bounded nullable string the validator accepts', () => {
    const published = bodies['patch /v1/assets/{id}'] as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(published.properties.assetTag).toMatchObject({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      nullable: true,
    });
  });

  /**
   * FU-078 r2 F2: the published identifier schemas, compiled by AJV, against the validating pipe the
   * route really runs. Bounds the service applies to canonicalised text were published for the raw
   * text: tatweel padding (67 characters, canonical 3) was refused by the document and accepted by
   * the service. The published verdict must now be the runtime verdict, except for the one rule
   * JSON Schema cannot state — the canonical form's own length, which the field's description gives
   * — so `runtime === published && canonical within bounds`, for every probe of every field.
   */
  describe.each([
    ['post /v1/assets', 'assetTag', 1, 64, { name: 'Loader one', type: 'LOADER' }],
    ['post /v1/assets', 'serialNumber', 3, 120, { name: 'Loader one', type: 'LOADER' }],
    ['patch /v1/assets/{id}', 'assetTag', 1, 64, { expectedVersion: 1 }],
    [
      'post /v1/assets/{id}/insurance-policies',
      'policyNumber',
      3,
      64,
      {
        insurerName: 'Iran Insurance',
        coverage: 'THIRD_PARTY',
        validFrom: '2026-01-01T00:00:00Z',
        validTo: '2027-01-01T00:00:00Z',
      },
    ],
  ] as const)('%s %s', (route, field, min, max, base) => {
    const probes: Record<string, string> = {
      'shortest canonical': 'A'.repeat(min),
      'longest canonical': 'A'.repeat(max),
      'one too long': 'A'.repeat(max + 1),
      'tatweel padding past the bound': 'abc' + '\u0640'.repeat(max),
      'tatweel padding within the bound': 'abc' + '\u0640'.repeat(max - 3),
      'whitespace padding past the bound': '  abc  ' + ' '.repeat(max),
      'U+FDFA expanding past the bound': '\uFDFA'.repeat(Math.ceil((max + 1) / 18)),
      'empty after canonicalisation': '\u0640'.repeat(min),
      'Persian digits': '۱۲۳' + 'A'.repeat(max - 3),
      'astral characters at the bound': '😀'.repeat(max),
      'a bidi control': 'ab\u202Ec',
    };
    let accepts: (body: unknown) => boolean;
    let pipe: ZodValidationPipe<z.ZodType>;
    const runtime = (body: unknown) => {
      try {
        pipe.transform(body, { type: 'body' });
        return true;
      } catch {
        return false;
      }
    };

    beforeAll(() => {
      const ajv = new Ajv({ strict: true, allErrors: true });
      addFormats(ajv);
      ajv.addVocabulary(['example', 'xml', 'externalDocs']);
      accepts = ajv.compile(bodies[route] as object) as (body: unknown) => boolean;
      const served = validated.filter(
        (input) => input.kind === 'body' && operationOf(input.handler).route === route,
      );
      expect(served).toHaveLength(1);
      pipe = new ZodValidationPipe(served[0]!.schema);
    });

    it('accepts the base body in both', () => {
      const body = { ...base, [field]: probes['shortest canonical'] };
      expect([accepts(body), runtime(body)]).toEqual([true, true]);
    });

    it.each(Object.keys(probes))('%s', (probe) => {
      const raw = probes[probe]!;
      const body = { ...base, [field]: raw };
      const canonical = [...canonicalIdentifier(raw.trim())].length;
      const published = accepts(body);
      expect({ probe, runtime: runtime(body) }).toEqual({
        probe,
        runtime:
          published && canonical >= min && canonical <= max && !/\p{Bidi_Control}/u.test(raw),
      });
      // The published bounds are the raw ones, enforced as published.
      if ([...raw].length > max) expect(published).toBe(false);
    });

    it('publishes the canonical rule it cannot state as a schema', () => {
      const published = (bodies[route] as { properties: Record<string, { description?: string }> })
        .properties[field];
      expect(published).toMatchObject({ type: 'string', minLength: min, maxLength: max });
      expect(published?.description).toMatch(/after canonicalisation/);
    });
  });

  it.each([
    ['post /v1/assets/{id}/activate', 'commissionedAt', activateAssetSchema],
    ['post /v1/assets/{id}/decommission', 'decommissionedAt', decommissionSchema],
  ] as const)('%s says %s is UTC only, as the validator enforces', (operation, field, schema) => {
    const published = (bodies[operation] as { properties: Record<string, unknown> }).properties[
      field
    ];
    expect(published).toMatchObject({ type: 'string', format: 'date-time' });
    expect((published as { description: string }).description).toMatch(/UTC.*`\+03:30`/s);
    const at = (instant: string) => schema.safeParse({ ...validBody(schema), [field]: instant });
    expect(at('2026-11-04T06:30:00Z').success).toBe(true);
    expect(at('2026-11-04T10:00:00+03:30').success).toBe(false);
  });

  function validBody(schema: z.ZodType): Record<string, unknown> {
    return schema === decommissionSchema
      ? { expectedVersion: 1, reason: 'retired after inspection' }
      : { expectedVersion: 1 };
  }
});

describe('raw asset query constraints (FU-120)', () => {
  it.each([' ' + 'a'.repeat(100) + ' ', '   '])(
    'documents transformed q honestly: %j',
    async (q) => {
      const document = await buildDocument();
      const parameter = document.paths['/v1/assets']!.get!.parameters!.find(
        (p) => 'name' in p && p.name === 'q',
      ) as unknown as { schema: Record<string, unknown> };
      expect(listAssetsQuerySchema.safeParse({ q }).success).toBe(q.length === 102);
      expect(parameter.schema).toEqual({
        type: 'string',
        description:
          'Constraints after a value-changing step are omitted; validation applies them to the transformed value.',
      });
    },
  );
});
