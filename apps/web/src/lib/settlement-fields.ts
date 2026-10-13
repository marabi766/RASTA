/**
 * What `/settlements` knows about a settlement without reaching the gateway.
 *
 * Separate from `server/settlements.ts` for the reason `order-fields.ts` is
 * separate from `server/orders.ts`: this file is plain data a screen and a
 * test can import without pulling the gateway client in.
 */

/**
 * Which side of a settlement the caller is asking about. economic-service's
 * own term is `incoming=true|false`; the portal says who paid whom, because
 * "incoming" means nothing to a person looking at a tab.
 */
export const SETTLEMENT_VIEWS = ['PAID', 'RECEIVED'] as const;
export type SettlementView = (typeof SETTLEMENT_VIEWS)[number];

export const SETTLEMENT_VIEW_LABELS: Readonly<Record<SettlementView, string>> = {
  PAID: 'پرداخت‌شده',
  RECEIVED: 'دریافت‌شده',
};

export function isSettlementView(value: string | undefined): value is SettlementView {
  return (SETTLEMENT_VIEWS as readonly string[]).includes(value ?? '');
}

/**
 * The roles `GET /v1/settlements` admits (`settlement.controller.ts`).
 *
 * Used only to decide whether the navigation offers the entry. **That is UX,
 * not access control**: the gateway and economic-service refuse everyone else
 * whatever this list says, and a person who types the address gets the
 * service's answer.
 */
export const SETTLEMENT_READ_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN'] as const;

/**
 * Every settlement here was made by the simulated provider (ADR-024): no bank
 * is involved and no real money moved. A fixed sentence, because a settlement
 * is a ledger entry that exists whether or not any provider read succeeds.
 */
export const SETTLEMENT_SIMULATION_NOTICE =
  'این تسویه‌ها در حالت نمایشی ثبت شده‌اند: به هیچ بانک یا درگاه واقعی متصل نیستند و پولی جابه‌جا نشده است.';
