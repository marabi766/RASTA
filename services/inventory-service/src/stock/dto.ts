import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import {
  MAX_QUANTITY,
  productIdSchema,
  quantitySchema,
  sourceReferenceSchema,
  stockItemIdSchema,
  warehouseIdSchema,
} from '../shared/dto';

/**
 * The request and response shapes of the stock API (ADR-056 § 3): balances, the ledger, and the
 * two commands that change on hand without a reservation.
 */

/** `POST /v1/stock/receipts`: stock arrived. Creates the stock item on its first receipt. */
export const receiveStockSchema = z
  .object({
    warehouseId: warehouseIdSchema,
    productId: productIdSchema,
    quantity: quantitySchema,
    sourceReference: sourceReferenceSchema.optional(),
  })
  .strict();
export type ReceiveStockDto = z.infer<typeof receiveStockSchema>;

/**
 * `POST /v1/stock/adjustments`: on hand corrected by a signed delta — a count, a loss, or
 * ADR-056's direct issue without a reservation. Never below what is reserved.
 */
export const adjustStockSchema = z
  .object({
    stockItemId: stockItemIdSchema,
    quantityDelta: z
      .number()
      .int()
      .min(-MAX_QUANTITY)
      .max(MAX_QUANTITY)
      .refine((value) => value !== 0, 'quantityDelta may not be zero')
      .describe(
        'A signed whole number, never zero: positive adds to on hand, negative removes. On hand ' +
          'may not fall below what is reserved (422 ON_HAND_WOULD_BE_NEGATIVE).',
      ),
    sourceReference: sourceReferenceSchema.optional(),
  })
  .strict();
export type AdjustStockDto = z.infer<typeof adjustStockSchema>;

const optionalId = z.string().min(1).max(64).optional();

export const listStockQuerySchema = cursorPaginationSchema
  .extend({ warehouseId: optionalId, productId: optionalId })
  .strict();
export type ListStockQuery = z.infer<typeof listStockQuerySchema>;

export const listMovementsQuerySchema = cursorPaginationSchema
  .extend({ stockItemId: optionalId, warehouseId: optionalId })
  .strict();
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;

export const stockItemViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The warehouse owner.'),
    warehouseId: z.string(),
    productId: z.string(),
    onHandQuantity: z.number().int().describe('Physically in the warehouse.'),
    reservedQuantity: z.number().int().describe('Held by ACTIVE reservations.'),
    availableQuantity: z
      .number()
      .int()
      .describe('On hand minus reserved: what can still be reserved. Never negative.'),
    version: z
      .number()
      .int()
      .describe('The item’s position in its own ledger: the number of movements applied to it.'),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type StockItemView = z.infer<typeof stockItemViewSchema>;

export const MOVEMENT_TYPES = ['RECEIPT', 'RESERVE', 'RELEASE', 'ISSUE', 'ADJUSTMENT'] as const;

export const stockMovementViewSchema = z
  .object({
    id: z.string(),
    stockItemId: z.string(),
    warehouseId: z.string(),
    type: z.enum(MOVEMENT_TYPES),
    onHandDelta: z.number().int(),
    reservedDelta: z.number().int(),
    onHandAfter: z.number().int(),
    reservedAfter: z.number().int(),
    itemVersion: z
      .number()
      .int()
      .describe('The ledger position this movement brought its stock item to: 1, 2, 3, …'),
    reservationId: z.string().nullable(),
    sourceReference: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z
      .string()
      .describe('The user id of the person, or `inventory-service` for an expiry.'),
  })
  .strict();
export type StockMovementView = z.infer<typeof stockMovementViewSchema>;

/** What a receipt or an adjustment answers: the item as it now stands, and its movement. */
export const stockChangeViewSchema = z
  .object({ stockItem: stockItemViewSchema, movement: stockMovementViewSchema })
  .strict();
export type StockChangeView = z.infer<typeof stockChangeViewSchema>;
