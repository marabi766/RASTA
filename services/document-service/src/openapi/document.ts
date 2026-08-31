import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import {
  deleteDocumentSchema,
  documentViewSchema,
  finalizeDocumentSchema,
  listDocumentsQuerySchema,
  requestUploadUrlSchema,
} from '../document/dto';

/**
 * Fills in what Nest cannot see.
 *
 * Nest derives paths, methods and security from the decorators; it cannot see
 * a Zod schema, so the payload shapes are added afterwards from the very
 * schemas the service validates with. One definition rather than a decorated
 * class and a hand-written document that drift.
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
 * Which endpoints return a document, and in what shape.
 *
 * Published as a real schema rather than the empty `{}` that stood here
 * before, because a success response nobody described is a contract a client
 * has to reverse-engineer from a live call. It matters most for `scanState`:
 * ADR-049 made scanning asynchronous, so a freshly registered document is
 * `PENDING` and undownloadable, and a client that has not been told the states
 * exist will show a download control that always fails.
 *
 * Derived from `documentViewSchema`, which the service's own return type is
 * inferred from — so this cannot advertise a field the service does not send.
 */
const RESPONSE_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/documents': documentViewSchema,
  'GET /v1/documents/{id}': documentViewSchema,
  'DELETE /v1/documents/{id}': documentViewSchema,
  'GET /v1/documents': z.object({
    items: z.array(documentViewSchema),
    nextCursor: z.string().nullable(),
  }),
};

const REQUEST_BODIES: Record<string, z.ZodTypeAny> = {
  'POST /v1/documents/upload-url': requestUploadUrlSchema,
  'POST /v1/documents': finalizeDocumentSchema,
  'DELETE /v1/documents/{id}': deleteDocumentSchema,
};

const QUERY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'GET /v1/documents': listDocumentsQuerySchema,
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request does not match the published schema',
  401: 'No credentials, or a token that is expired or invalid',
  403: 'Authenticated, but the role or the requested organization is not permitted',
  404: 'Not found — also returned for a document owned by another organization, so its existence is never disclosed',
  409: 'Conflict: the resource already exists or another request changed it first',
  422: 'The request is well-formed but a business rule refuses it (see `code`) — an unsupported content type, a size over the limit, a mismatch between the declared and actual content, an expired upload intent, or a document whose scan state does not permit download. Scanning is asynchronous (ADR-049), so a document registered moments ago is `PENDING` and a download request for it is refused here until the scan clears it; the refusal carries the scan state as `reason`.',
  500: 'Unexpected server error',
};

export interface OpenApiOptions {
  /**
   * How long a signed URL lasts, from the running configuration.
   *
   * Required rather than defaulted. Both durations are bounded but tunable, so
   * a constant here would be a second source of truth that silently disagrees
   * with the deployment the reader is looking at — and for a credential
   * lifetime that is worse than unhelpful: a client building a retry or a
   * cache around the wrong number gets URLs that expire under it.
   */
  signedUrlTtlSeconds: number;
  uploadIntentTtlSeconds: number;
}

export function enrichOpenApiDocument(
  document: OpenAPIObject,
  options: OpenApiOptions,
): OpenAPIObject {
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

      // The durations, stated where a client will look for them rather than in
      // a separate document nobody reads alongside the endpoint.
      if (key === 'POST /v1/documents/upload-url') {
        operation.description =
          `${operation.description ?? ''} The signed URL is valid for ` +
          `${options.signedUrlTtlSeconds} seconds and the upload intent for ` +
          `${options.uploadIntentTtlSeconds} seconds, both from this deployment's ` +
          `configuration rather than a platform constant.`;
      }
      if (key === 'POST /v1/documents/{id}/download-url') {
        operation.description =
          `${operation.description ?? ''} The signed URL is valid for ` +
          `${options.signedUrlTtlSeconds} seconds, from this deployment's configuration.`;
      }

      const success = successStatus(method, key);
      const responseBody = RESPONSE_BODIES[key];
      operation.responses ??= {};
      operation.responses[success] = {
        description: 'Success',
        content: {
          'application/json': { schema: responseBody ? toJsonSchema(responseBody) : {} },
        },
      };

      for (const [status, description] of Object.entries(ERROR_DESCRIPTIONS)) {
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

/**
 * The status a successful call actually returns, where it is not the default.
 *
 * A POST usually creates something, so 201 is the right default — but issuing
 * a download URL creates nothing and answers 200 (`@HttpCode` in the
 * controller). Publishing 201 for it would be a contract that disagrees with
 * the service, and a client checking `status === 201` would read every
 * successful download-URL request as a failure.
 */
const SUCCESS_STATUS: Record<string, string> = {
  'POST /v1/documents/{id}/download-url': '200',
};

function successStatus(method: string, key: string): string {
  return SUCCESS_STATUS[key] ?? (method.toUpperCase() === 'POST' ? '201' : '200');
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

function toQueryParameters(schema: z.ZodTypeAny): unknown[] {
  const jsonSchema = toJsonSchema(schema);
  const properties = (jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((jsonSchema.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema: propertySchema,
  }));
}
