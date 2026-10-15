import { groupDigits, toPersianDigits } from '@/lib/format';

/**
 * The inventory vocabulary the `/inventory` screens render (docs/16 § ۱۶٫۶;
 * inventory-service `WarehouseView` / `StockItemView`, ADR-056).
 */

/** The largest quantity inventory-service stores (`integer`): a reader schema's ceiling. */
export const MAX_STOCK_QUANTITY = 2_147_483_647;

/** `WHS_<ULID>` — the shape a warehouse id filter must have to be forwarded. */
const WAREHOUSE_ID = /^WHS_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isWarehouseId(value: string | undefined): value is string {
  return value !== undefined && WAREHOUSE_ID.test(value);
}

/**
 * A quantity as Persian digits with the thousands separator.
 *
 * Quantities are whole numbers in the product's base unit (Q-105) and are only
 * ever grouped as text — never divided, scaled or rounded.
 */
export function formatQuantity(quantity: number): string {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError('a stock quantity is a non-negative whole number');
  }
  return toPersianDigits(groupDigits(String(quantity)));
}
