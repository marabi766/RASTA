import type { ApiQueryOptions } from '@nestjs/swagger';
import { z } from 'zod';
import { isOptionalField, toJsonSchema } from '@rasta/nest-common';

/**
 * A Zod query schema as OpenAPI parameters, published by `ValidatedQuery` (`./validated.ts`) from
 * the same registration that validates the query (FU-078).
 *
 * This service builds its document from decorators alone — there is no
 * document-enrichment step like economic-service's — so without this, a query
 * schema was validated on every request and described nowhere. `availableOnly`
 * was accepted, parsed and acted on while the published document said the
 * endpoint took no parameters at all (D-023).
 *
 * Derived from the schema rather than hand-written beside it, for the reason
 * the defect it publishes exists in the first place: two descriptions of one
 * parameter drift, and the one nobody executes drifts first.
 *
 * Every field uses the shared converter, just like request bodies. Opaque
 * preprocessors publish an open marked schema rather than their output type.
 */
export function parametersOf(schema: z.ZodObject): ApiQueryOptions[] {
  return Object.entries(schema.shape).map(([name, field]) => describe(name, field as z.ZodType));
}

function describe(name: string, field: z.ZodType): ApiQueryOptions {
  const required = !isOptionalField(field);
  const schema = toJsonSchema(field);

  return { name, required, schema };
}
