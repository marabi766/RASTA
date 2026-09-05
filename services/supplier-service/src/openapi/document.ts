import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import {
  approveQualificationSchema,
  listQualifiedForQuerySchema,
  qualificationViewSchema,
  registerSupplierSchema,
  reinstateSupplierSchema,
  rejectQualificationSchema,
  reviewQueueQuerySchema,
  searchSuppliersQuerySchema,
  submitQualificationSchema,
  supplierDetailViewSchema,
  supplierDirectoryViewSchema,
  suspendSupplierSchema,
} from '../supplier/dto';

/**
 * Fills in what Nest cannot see.
 *
 * Nest derives paths, methods and security from the decorators; it cannot see a
 * Zod schema, so the payload shapes are added afterwards from the very schemas
 * the service validates with. One definition rather than a decorated class and a
 * hand-written document that drift.
 *
 * The response bodies matter more here than in most services, because the
 * difference between the two projections is a security boundary: a client that
 * believed `GET /v1/suppliers` returned the detail view would build a UI around
 * evidence identifiers it will never receive, and — worse — a reviewer building
 * against it might assume the directory already shows them what the queue does.
 * The document says which is which.
 */

const apiErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    correlationId: z.string().optional(),
    details: z.array(z.unknown()).optional(),
  })
  .strict();

const cursorPageOf = (item: z.ZodTypeAny) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  });

/** The private queue entry: a qualification plus who it belongs to. */
const reviewQueueEntrySchema = qualificationViewSchema.extend({
  supplierId: z.string(),
  supplierOrganizationId: z.string(),
  supplierDisplayName: z.string(),
});

/**
 * Success responses, each with the status the handler actually answers.
 *
 * The status is written down beside the schema rather than derived from the
 * method, because deriving it is exactly how document-service published a `201`
 * for an endpoint that answers `200` (commit cb8d435). Two of the POSTs here
 * create something and answer `201`; the other five act on something that
 * already exists and answer `200`.
 */
const RESPONSE_BODIES: Record<string, { status: '200' | '201'; schema: z.ZodTypeAny }> = {
  'POST /v1/suppliers': { status: '201', schema: supplierDetailViewSchema },
  'GET /v1/suppliers/{id}': { status: '200', schema: supplierDetailViewSchema },
  'POST /v1/suppliers/{id}/suspend': { status: '200', schema: supplierDetailViewSchema },
  'POST /v1/suppliers/{id}/reinstate': { status: '200', schema: supplierDetailViewSchema },

  // The catalogue-safe projection. Deliberately a different schema from the
  // detail view above, and published as one.
  'GET /v1/suppliers': { status: '200', schema: cursorPageOf(supplierDirectoryViewSchema) },
  'GET /v1/suppliers/qualified': {
    status: '200',
    schema: cursorPageOf(supplierDirectoryViewSchema),
  },

  'GET /v1/suppliers/qualifications': {
    status: '200',
    schema: cursorPageOf(reviewQueueEntrySchema),
  },
  'POST /v1/suppliers/{id}/qualifications': { status: '201', schema: qualificationViewSchema },
  'POST /v1/suppliers/{id}/qualifications/{qualificationId}/approve': {
    status: '200',
    schema: qualificationViewSchema,
  },
  'POST /v1/suppliers/{id}/qualifications/{qualificationId}/reject': {
    status: '200',
    schema: qualificationViewSchema,
  },
};

const REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/suppliers': registerSupplierSchema,
  'POST /v1/suppliers/{id}/qualifications': submitQualificationSchema,
  'POST /v1/suppliers/{id}/qualifications/{qualificationId}/approve': approveQualificationSchema,
  'POST /v1/suppliers/{id}/qualifications/{qualificationId}/reject': rejectQualificationSchema,
  'POST /v1/suppliers/{id}/suspend': suspendSupplierSchema,
  'POST /v1/suppliers/{id}/reinstate': reinstateSupplierSchema,
};

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/suppliers': searchSuppliersQuerySchema,
  'GET /v1/suppliers/qualified': listQualifiedForQuerySchema,
  'GET /v1/suppliers/qualifications': reviewQueueQuerySchema,
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request does not match the published schema. Unknown fields are refused rather than ignored, so a misspelled field is a 400 and never a silently dropped value.',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but not permitted. Also returned when a platform operator belongs to the supplier’s own organization: no role exempts anybody from the rule that a supplier organization may not decide its own qualification, suspension or reinstatement.',
  404: 'Not found — also returned for a supplier owned by another organization, so its existence is never disclosed through the private endpoints. The directory is where a stranger legitimately learns a supplier exists, and it returns a catalogue-safe object.',
  409: 'Conflict: this organization already has a supplier profile',
  422: 'The request is well-formed but a business rule refuses it (see `code`) — a qualification that is already decided, a second submission for a capability that is open or approved, suspending a supplier that is already suspended, or reinstating one that is not.',
  500: 'Unexpected server error',
};

export function enrichOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = toJsonSchema(apiErrorSchema) as never;

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!isOperation(operation)) continue;

      const key = `${method.toUpperCase()} ${path}`;

      const body = REQUEST_BODIES[key];
      if (body) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: toJsonSchema(body) } },
        };
      }

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
}

function isOperation(value: unknown): value is MutableOperation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Turns a query DTO into OpenAPI parameters.
 *
 * Reads the object's shape after unwrapping the effects wrappers a
 * `.superRefine()` adds — otherwise a schema with a cross-field rule publishes
 * no parameters at all, and the failure is invisible because the document is
 * still valid.
 */
function toQueryParameters(schema: z.ZodTypeAny): unknown[] {
  const shape = objectShapeOf(schema);
  if (!shape) return [];

  return Object.entries(shape).map(([name, member]) => {
    const jsonSchema = toJsonSchema(member);
    return {
      name,
      in: 'query',
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
