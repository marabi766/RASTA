import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { auditEventDetailQuerySchema, auditEventQuerySchema } from '../audit/audit.query.dto';
import { auditEventPageSchema, auditEventViewSchema } from '../audit/audit.view';

/**
 * Fills in what Nest cannot see.
 *
 * Nest derives paths, methods and security from the decorators; it cannot see a
 * Zod schema, so the parameter and response shapes are added afterwards **from
 * the very schemas the service validates and serialises with**. One definition
 * rather than a decorated class beside a hand-written document that drift.
 *
 * That single sourcing is the point here more than anywhere else in the
 * repository: `from` and `to` are mandatory, and the marketplace lesson
 * recorded in the implementation plan is exactly this failure — the contract
 * did not publish a required `Idempotency-Key`, so clients did not send one. A
 * client that does not know `from` and `to` are required will send neither and
 * meet a 400 it could not have predicted, on every request.
 *
 * ## No document is committed to the repository
 *
 * The document is generated at boot and served at `/docs`, and
 * `test/openapi.int-spec.ts` builds it from the running application and
 * compares it against the router that application answers on. Nothing is
 * checked in, because this repository has no committed OpenAPI artifact for any
 * service and inventing one here would create a second thing to keep in step —
 * with no generator, no CI check and no consumer asking for it.
 */

const apiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  })
  .strict();

/**
 * Success responses, each with the status the handler actually answers.
 *
 * Written beside the schema rather than derived from the method, because
 * deriving it is how document-service came to publish a `201` for an endpoint
 * that answers `200`. Both of these are reads, and both answer `200`.
 */
const RESPONSE_BODIES: Record<string, { status: '200'; schema: z.ZodTypeAny }> = {
  'GET /v1/audit-events': { status: '200', schema: auditEventPageSchema },
  'GET /v1/audit-events/{id}': { status: '200', schema: auditEventViewSchema },
};

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/audit-events': auditEventQuerySchema,
  'GET /v1/audit-events/{id}': auditEventDetailQuerySchema,
};

/**
 * The reachable error statuses, and only those.
 *
 * Each one is produced by a code path a test exercises. `409` and `422` are
 * absent because nothing here conflicts or refuses on a business rule — this
 * service reads, and a read has no state to disagree with.
 */
export const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request does not match the published schema. `from` and `to` are mandatory, `to` may not precede `from`, and the window may not exceed `AUDIT_MAX_QUERY_WINDOW_DAYS` (default 90) — the message names the configured limit. `resourceId` requires `resourceType`. Unknown parameters are refused rather than ignored, so a misspelled filter is a 400 and never a silently narrower answer. An invalid or unparseable `cursor` lands here too.',
  401: 'No credentials, or a token that is expired, unverifiable or issued for another audience.',
  403: 'Authenticated, but not permitted. Only `SYSTEM_ADMIN` and `UNION_ADMIN` reach audit records; `AUDITOR`, `ORGANIZATION_ADMIN`, every unlisted role and every service token are refused. Also returned to a `UNION_ADMIN` who names an `organizationId` the local hierarchy projection does not prove is beneath their own — including one that has moved out and one no projection exists for.',
  404: 'Not found. Also returned for a record that exists under another tenant, or outside the supplied `from`..`to` window, so a record’s existence is never disclosed by the difference between two statuses.',
  500: 'Unexpected server error.',
};

/**
 * The service description the published contract carries.
 *
 * Says what the store does and — at least as importantly — what it does not, so
 * a reader cannot mistake a null field for a verified one. Lives here rather
 * than in `main.ts` because `test/openapi.int-spec.ts` builds the document from
 * this same function: a contract generated one way and tested another is two
 * contracts.
 */
const DESCRIPTION =
  'The append-only evidence store. Records are written only by consuming domain ' +
  'events from Kafka — there is no write endpoint and never will be (docs/04 § 4.15) — ' +
  'and they are never updated, deleted or truncated, which the database enforces ' +
  'independently through privileges and a trigger. Reading is restricted to ' +
  'SYSTEM_ADMIN and UNION_ADMIN; the oversight AUDITOR role has no access to this ' +
  'service at all. Every query must state a bounded from..to window. Records produced ' +
  'by the domain projector carry no actor roles, no source address and no field-level ' +
  'delta, because a domain event does not carry them: those arrive with the explicit ' +
  'audit trail (AUD-004). No integrity chain is computed or verified yet (AUD-003), so ' +
  'no response asserts that a record is unaltered.';

/** Builds the finished document for a booted application. */
export function buildAuditOpenApiDocument(
  app: INestApplication,
  serviceVersion: string,
): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Rasta — Audit Service')
      .setDescription(DESCRIPTION)
      .setVersion(serviceVersion)
      .addBearerAuth()
      .build(),
  );

  return enrichOpenApiDocument(document);
}

export function enrichOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;

      // Stated on the operation, not only in `components.securitySchemes`.
      // `DocumentBuilder.addBearerAuth()` *declares* the scheme; it does not
      // apply it, and without this the published contract would describe a
      // service whose endpoints are open while the guard answers 401 to every
      // one of them. On an audit API that is not a documentation nicety: a
      // reviewer reading the contract must be able to see the store is closed.
      operation.security ??= [{ bearer: [] }];

      const query = QUERY_SCHEMAS[key];
      if (query) {
        operation.parameters = [...(operation.parameters ?? []), ...toQueryParameters(query)];
      }

      const response = RESPONSE_BODIES[key];
      if (response) {
        operation.responses ??= {};
        operation.responses[response.status] = {
          description: 'Success',
          content: { 'application/json': { schema: toJsonSchema(response.schema) } },
        };
      }

      for (const [status, description] of Object.entries(ERROR_DESCRIPTIONS)) {
        operation.responses ??= {};
        operation.responses[status] ??= {
          description,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
          },
        };
      }
    }
  }

  return document;
}

interface MutableOperation {
  requestBody?: unknown;
  parameters?: unknown[];
  responses?: Record<string, unknown>;
  description?: string;
  security?: Record<string, string[]>[];
}

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns a query DTO into OpenAPI parameters.
 *
 * Reads the object's shape after unwrapping the effects wrappers that
 * `.superRefine()` and `.transform()` add — otherwise a schema with a
 * cross-field rule publishes no parameters at all, and the failure is invisible
 * because the document is still valid. Both audit query schemas carry both
 * wrappers, so this unwrapping is load-bearing rather than defensive.
 */
function toQueryParameters(schema: z.ZodTypeAny): unknown[] {
  const shape = objectShapeOf(schema);
  if (!shape) return [];

  return Object.entries(shape).map(([name, member]) => {
    const jsonSchema = toJsonSchema(member);
    return {
      name,
      in: 'query',
      // `from` and `to` are the two that matter: published as required, from
      // the same schema that rejects a request without them.
      required: !member.isOptional(),
      schema: jsonSchema,
    };
  });
}

function objectShapeOf(schema: z.ZodTypeAny): z.ZodRawShape | undefined {
  // JUSTIFIED-ANY: zod's `_def` is untyped across its type-kinds, and the walk
  // below re-checks the kind before reading a field.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = schema;

  for (let depth = 0; depth < 10; depth += 1) {
    const typeName = current?._def?.typeName;
    if (typeName === z.ZodFirstPartyTypeKind.ZodObject) {
      return (current as z.ZodObject<z.ZodRawShape>).shape;
    }
    if (typeName === z.ZodFirstPartyTypeKind.ZodEffects) {
      current = current._def.schema;
      continue;
    }
    if (
      typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
      typeName === z.ZodFirstPartyTypeKind.ZodDefault
    ) {
      current = current._def.innerType;
      continue;
    }
    return undefined;
  }

  return undefined;
}
