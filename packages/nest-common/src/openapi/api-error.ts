import { z } from 'zod';
import { apiErrorSchema, errorDetailSchema } from '@rasta/contracts';

/**
 * The platform error envelope as a service **publishes** it: the fields of the shared
 * `apiErrorSchema` — `code`, `message`, `correlationId` and `timestamp` always, `traceId` and `path`
 * when the request context has them, `details` only when non-empty — and closed, so an unknown field
 * is still refused (`additionalProperties: false`).
 *
 * Built from the shared schema so the document cannot drift from what `AllExceptionsFilter` sends
 * (audit 10-26 F3: seven services kept a strict local copy without `timestamp`, `traceId` and
 * `path`, so a client validating against the document refused every real error). Closing it is the
 * service's choice and stays here, not in `@rasta/contracts`: the gateway parses upstream errors
 * with the open `apiErrorSchema` (proxy.service.ts) and must keep tolerating a field it does not know.
 *
 * A typed refusal narrows `details` with `.extend({ details: … })` on this schema.
 */
export const publishedErrorDetailSchema = errorDetailSchema.strict();

export const publishedApiErrorSchema = apiErrorSchema
  .extend({ details: z.array(publishedErrorDetailSchema).optional() })
  .strict();
