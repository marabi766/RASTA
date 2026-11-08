import { z } from 'zod';
import { publishedApiErrorSchema } from './api-error';
import { toJsonSchema } from './zod-schema';
import {
  errorResponseSchema,
  unresolvedRefs,
  type PublishedDocument,
  type PublishedSchema,
} from './published-body';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const ERROR_REF = { $ref: '#/components/schemas/ApiError' };

/** Enrich Nest's finished document, including existing error responses and future operations. */
export function publishApiErrors<T extends PublishedDocument>(
  document: T,
  probeExceptions: Readonly<Record<string, PublishedSchema>> = {},
): T {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = toJsonSchema(publishedApiErrorSchema);
  const remaining = new Set(Object.keys(probeExceptions));
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, value] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method)) continue;
      const operation = value as {
        responses: Record<string, { description?: string; content?: unknown }>;
      };
      operation.responses ??= {};
      if (!Object.hasOwn(operation.responses, 'default')) {
        operation.responses.default = { description: 'Platform error' };
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status !== 'default' && !/^[45][0-9X]{2}$/.test(status)) continue;
        // FU-031: a route's own typed refusal (api-error.ts: `.extend({ details: … })`) is kept,
        // not overwritten by the plain envelope. A referenced response, or anything that is not
        // exactly one resolvable JSON schema, is refused: never published as-is (r2 F1).
        const at = `${method.toUpperCase()} ${path} ${status}`;
        const schema = errorResponseSchema(response, at);
        if (schema === undefined) {
          response.content = { 'application/json': { schema: ERROR_REF } };
          continue;
        }
        const missing = unresolvedRefs(document, schema);
        if (missing.length) throw new Error(`${at}: unresolved ${missing.join(', ')}`);
      }
      const key = `${method.toUpperCase()} ${path} 503`;
      const health = probeExceptions[key];
      if (health) {
        // A consumer crash can throw through the filter before the direct health response.
        operation.responses['503'] = {
          description: 'Orchestrator probe unavailable (D-121)',
          content: { 'application/json': { schema: { anyOf: [ERROR_REF, health] } } },
        };
        remaining.delete(key);
      }
    }
  }
  if (remaining.size)
    throw new Error(`Probe exceptions have no operation: ${[...remaining].join(', ')}`);
  return document;
}

/** D-121: preserve the health-status body consumed by orchestrator tooling. */
export function healthProbeErrorSchema(
  service: string,
  probe: 'ready' | 'startup',
  startupChecks: readonly string[] = ['database'],
): PublishedSchema {
  const checks = z
    .object(
      Object.fromEntries(
        (probe === 'ready' ? ['database', 'kafka'] : startupChecks).map((name) => [
          name,
          z.boolean(),
        ]),
      ),
    )
    .strict();
  const schema =
    probe === 'ready'
      ? z
          .object({
            status: z.literal('unavailable'),
            service: z.literal(service),
            checks,
            degraded: z.array(z.string()),
          })
          .strict()
      : z.object({ status: z.literal('starting'), checks }).strict();
  return {
    ...toJsonSchema(schema),
    description:
      'D-121 exception: orchestrator probe health-status body retained for probe tooling compatibility.',
  };
}
