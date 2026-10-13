import { z } from 'zod';
import { cursorPaginationSchema } from '@rasta/contracts';
import { expectedVersionSchema, quantitySchema, stockItemIdSchema } from '../shared/dto';

/**
 * The request and response shapes of the reservation API (ADR-056 § 3).
 */

/** The most lines one reservation request carries: protection of the service, not a rule. */
export const MAX_RESERVATION_LINES = 50;

export const RESERVATION_STATES = ['ACTIVE', 'CONSUMED', 'RELEASED', 'EXPIRED'] as const;

/** `POST /v1/stock/reservations`: all lines or none, of one warehouse. */
export const reserveStockSchema = z
  .object({
    holderOrganizationId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Who the stock is held for. In this version the owner only — the organization the ' +
          'request acts for, and the default (Q-104); any other is 422 HOLDER_NOT_OWNER.',
      ),
    orderReference: z
      .string()
      .regex(/^(ORD|PO)_[0-9A-HJKMNP-TV-Z]{26}$/)
      .optional()
      .describe('Optional opaque `ORD_`/`PO_` reference of the order the stock is held for.'),
    expiresAt: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe(
        'Optional. When the reservation is released by itself if not issued or released first. ' +
          'No default: without it a reservation lives until released or issued (Q-102). Must be ' +
          'in the future and at most INVENTORY_RESERVATION_MAX_TTL_SECONDS (7 days by default) ' +
          'ahead, by the service’s clock (422 EXPIRY_OUT_OF_RANGE).',
      ),
    lines: z
      .array(z.object({ stockItemId: stockItemIdSchema, quantity: quantitySchema }).strict())
      .min(1)
      .max(MAX_RESERVATION_LINES)
      .refine(
        (lines) => new Set(lines.map((line) => line.stockItemId)).size === lines.length,
        'Each stock item appears once',
      )
      .describe(
        '1 to 50 lines, each a distinct stock item of one warehouse (422 LINES_SPAN_WAREHOUSES). ' +
          'All or nothing: one line short of available stock reserves none ' +
          '(422 INSUFFICIENT_AVAILABLE_STOCK). One reservation per line.',
      ),
  })
  .strict();
export type ReserveStockDto = z.infer<typeof reserveStockSchema>;

/** `POST /v1/stock/reservations/{id}/release` and `…/issue`. */
export const endReservationSchema = z.object({ expectedVersion: expectedVersionSchema }).strict();
export type EndReservationDto = z.infer<typeof endReservationSchema>;

export const listReservationsQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(RESERVATION_STATES).optional(),
    stockItemId: z.string().min(1).max(64).optional(),
  })
  .strict();
export type ListReservationsQuery = z.infer<typeof listReservationsQuerySchema>;

export const reservationViewSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().describe('The warehouse owner.'),
    warehouseId: z.string(),
    stockItemId: z.string(),
    holderOrganizationId: z.string(),
    orderReference: z.string().nullable(),
    quantity: z.number().int(),
    status: z.enum(RESERVATION_STATES),
    expiresAt: z.string().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
    endedAt: z
      .string()
      .nullable()
      .describe('When it was consumed, released or expired; null while ACTIVE.'),
    endedBy: z
      .string()
      .nullable()
      .describe('Who ended it — `inventory-service` for an expiry; null while ACTIVE.'),
    updatedAt: z.string(),
    version: z.number().int(),
  })
  .strict();
export type ReservationView = z.infer<typeof reservationViewSchema>;

/** What a reservation request answers: one reservation per line, in the order of the lines. */
export const reservationBatchViewSchema = z
  .object({ reservations: z.array(reservationViewSchema) })
  .strict();
export type ReservationBatchView = z.infer<typeof reservationBatchViewSchema>;
