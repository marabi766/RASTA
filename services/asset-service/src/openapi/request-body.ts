import type { ApiBodyOptions } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { toJsonSchema } from '@rasta/nest-common';
import type { z } from 'zod';

/**
 * A request body for `@ApiBody`, published as the shared converter's output
 * for the Zod schema the route validates with — the converter every other
 * service publishes its bodies through.
 *
 * This service builds its document from decorators alone, and a Zod schema is
 * invisible to that, so its bodies used to be typed out by hand beside the
 * DTOs. They drifted: `commissionedAt` and `decommissionedAt` were published
 * as any `date-time` while the DTO accepts UTC only, so a client sending
 * `+03:30` followed the contract and was refused (FU-078). Deriving the body
 * leaves nothing to drift; `document.spec.ts` holds every published body to
 * this function's output for its DTO.
 */
export function bodyFromSchema(schema: z.ZodType): ApiBodyOptions {
  return { schema: toJsonSchema(schema) as SchemaObject };
}
