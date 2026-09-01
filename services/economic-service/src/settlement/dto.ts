import { z } from 'zod';
import { queryBoolean } from '@rasta/config';

/**
 * Request shapes for the settlement API.
 *
 * Here rather than in the controller so the OpenAPI document can import it
 * without pulling a Nest controller — and its providers — into the document
 * builder. Every other module in this service is arranged the same way.
 */
export const listSettlementsQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /**
     * The payee view: settlements that paid this organization.
     *
     * `queryBoolean` rather than `z.coerce.boolean()`. The coercion applies
     * JavaScript's `Boolean()`, under which every non-empty string is true, so
     * `?incoming=false` served the payee view instead of the payer view the
     * caller asked for — two different answers to "what did I pay", chosen by
     * a parser rather than by the request.
     */
    incoming: queryBoolean(false),
  })
  .strict();

export type ListSettlementsQuery = z.infer<typeof listSettlementsQuerySchema>;
