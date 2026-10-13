import { z } from 'zod';
import { cursorPaginationSchema, plainText } from '@rasta/contracts';

/**
 * The request and response shapes of the warehouse API (ADR-056 § 5; COM-006 PR 1).
 */

export const MAX_WAREHOUSE_NAME_LENGTH = 200;

/** `POST /v1/warehouses`: a warehouse for the organization the request acts for. */
export const createWarehouseSchema = z
  .object({
    name: plainText()
      .min(1)
      .max(MAX_WAREHOUSE_NAME_LENGTH)
      .describe(
        'Trimmed, 1 to 200 characters, without bidirectional control characters. Shown to the ' +
          'owner’s people; never on an event.',
      ),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
      })
      .strict()
      .optional()
      .describe('Optional WGS 84 point. Never on an event.'),
    organizationId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Optional. The owner is always the organization the request acts for; naming any other ' +
          'organization is 403 FORBIDDEN (ADR-056 § 5, negative test 5), never a warehouse for it.',
      ),
  })
  .strict();
export type CreateWarehouseDto = z.infer<typeof createWarehouseSchema>;

export const listWarehousesQuerySchema = cursorPaginationSchema.strict();
export type ListWarehousesQuery = z.infer<typeof listWarehousesQuerySchema>;

export const warehouseViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The owner: the organization that operates it.'),
    name: z.string(),
    location: z
      .object({ latitude: z.number(), longitude: z.number() })
      .strict()
      .nullable()
      .describe('WGS 84 point, or null.'),
    status: z.literal('ACTIVE').describe('ACTIVE only in this version; the lifecycle is Q-108.'),
    createdAt: z.string(),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export type WarehouseView = z.infer<typeof warehouseViewSchema>;
