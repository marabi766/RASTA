import { z } from 'zod';

import { normalizePersianText, toLatinDigits, toPersianDigits } from '@/lib/format';
import {
  EMPTY_PLACE_ORDER_FORM,
  PLACE_ORDER_FIELDS,
  PLACE_ORDER_LIMITS as LIMITS,
  type PlaceOrderField,
  type PlaceOrderFormValues,
} from '@/lib/place-order-fields';

import type { WebSession } from './session';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * Placing an order, through the gateway: `POST /v1/orders`.
 *
 * The `orders` prefix is `requiresIdempotencyKey` at the gateway and
 * marketplace-service requires the key again itself, so the form's submission id
 * is the `Idempotency-Key` — and the service really replays: the same key with
 * the same body returns the original order instead of placing a second one.
 *
 * ## One line, no price
 *
 * The form places an order for **one offer**. The service accepts up to fifty
 * lines from one supplier, but a cart is deferred (ADR-037 § 3) and a multi-line
 * form would be a cart under another name. The body carries no price: the service
 * prices the order from its own current offers and refuses a body that has one.
 *
 * ## Refusals
 *
 * Every business refusal on this path is `BUSINESS_RULE_VIOLATION` (422); the
 * code does not say which rule. The sentences that are fixed are translated by
 * exact match; the two that carry the offer id and the live quantity
 * (minimum / available) are not matched — the code's fallback tells the person
 * the offer changed, which is true of both, and the screen already shows the
 * limits it read. An offer that is absent *or not published* answers 404, and
 * both read as "no longer on offer".
 */

/**
 * The roles `POST /v1/orders` admits (`order.controller.ts`). A Route Guard as
 * UX, not as security (`docs/16 § ۱۶٫۱۱`): it hides a form nobody in another
 * role could use, and marketplace-service refuses again.
 * `place-order.contract.spec.ts` fails the moment the two disagree.
 */
const PLACING_ROLES: readonly string[] = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'PROCUREMENT_USER',
];

export function canPlaceOrder(effectiveRoles: readonly string[]): boolean {
  return effectiveRoles.some((role) => PLACING_ROLES.includes(role));
}

export function placeOrderFormValues(form: FormData): PlaceOrderFormValues {
  const values: Record<PlaceOrderField, string> = { ...EMPTY_PLACE_ORDER_FORM };
  for (const field of PLACE_ORDER_FIELDS) {
    const raw = form.get(field);
    if (typeof raw !== 'string') continue;
    // An id is compared, not read: it is trimmed and nothing else. A quantity
    // is typed on a Persian keyboard as often as not.
    values[field] =
      field === 'quantity'
        ? toLatinDigits(raw).trim()
        : field === 'note'
          ? normalizePersianText(raw)
          : raw.trim();
  }
  return values;
}

/** A quantity is a count, not money: a `number` is the service's own type for it. */
const quantitySchema = z
  .string()
  .regex(/^[0-9]+$/, 'تعداد را به‌صورت عدد صحیح وارد کنید')
  .transform((value) => Number(value))
  .pipe(
    z
      .number()
      .int()
      .min(1, 'تعداد باید دست‌کم ۱ باشد')
      .max(
        LIMITS.quantity.max,
        `تعداد نباید بیش از ${toPersianDigits(String(LIMITS.quantity.max))} باشد`,
      ),
  );

const placeOrderSchema = z.object({
  offerId: z.string().min(1, 'پیشنهاد را انتخاب کنید').max(64, 'پیشنهاد را انتخاب کنید'),
  quantity: quantitySchema,
  note: z
    .string()
    .trim()
    .max(
      LIMITS.note.max,
      `یادداشت نباید بیش از ${toPersianDigits(String(LIMITS.note.max))} نویسه باشد`,
    )
    .transform((value) => (value.length === 0 ? undefined : value)),
});

export interface PlaceOrderRequest {
  readonly lines: readonly { readonly offerId: string; readonly quantity: number }[];
  readonly note?: string;
}

export type ParsedPlaceOrderForm =
  | { readonly ok: true; readonly request: PlaceOrderRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<PlaceOrderField, string>> };

export function parsePlaceOrderForm(values: PlaceOrderFormValues): ParsedPlaceOrderForm {
  const parsed = placeOrderSchema.safeParse(values);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<PlaceOrderField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string') {
        fieldErrors[field as PlaceOrderField] ??= issue.message;
      }
    }
    return { ok: false, fieldErrors };
  }

  const { offerId, quantity, note } = parsed.data;
  return {
    ok: true,
    request: { lines: [{ offerId, quantity }], ...(note === undefined ? {} : { note }) },
  };
}

export const PLACE_ORDER_FIELD_MAPPING: FieldMapping<PlaceOrderField> = {
  paths: {
    'lines[0].offerId': 'offerId',
    'lines[0].quantity': 'quantity',
    note: 'note',
  },
  messages: {
    'An organization cannot order from itself': 'سازمان شما نمی‌تواند از پیشنهاد خودش سفارش بدهد.',
    'An order must have a positive total': 'مجموع سفارش باید بیشتر از صفر باشد.',
    'Missing Idempotency-Key': 'درخواست دوباره ارسال شد؛ صفحه را تازه کنید.',
  },
  byCode: {
    // The minimum or the available quantity, or a rule this portal has no
    // sentence for. Nothing was placed.
    BUSINESS_RULE_VIOLATION:
      'سفارش با شرایط کنونی این پیشنهاد جور نیست؛ کمینهٔ سفارش یا موجودی ممکن است عوض شده باشد. صفحه را تازه کنید و دوباره بسنجید.',
    CONFLICT:
      'با همین ارسال پیش‌تر سفارشی ثبت شده است. فهرست سفارش‌ها را ببینید، و اگر لازم است سفارش تازه‌ای بدهید.',
  },
};

/** What the redirect needs of the placed order: only that it exists. */
const placedOrderSchema = z.object({ id: z.string().min(1) });

export function placeOrder(
  session: WebSession,
  request: PlaceOrderRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<z.infer<typeof placedOrderSchema>, PlaceOrderField>> {
  return writeThroughGateway(session, {
    path: '/v1/orders',
    body: request,
    submissionId,
    schema: placedOrderSchema,
    mapping: PLACE_ORDER_FIELD_MAPPING,
    fetchImpl,
  });
}
