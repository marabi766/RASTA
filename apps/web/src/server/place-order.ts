import { z } from 'zod';
import { legacyParse } from '@rasta/contracts';

import { firstIssuePerField } from '@/lib/form-issues';
import { BIDI_CONTROL, toLatinDigits, toPersianDigits } from '@/lib/format';
import {
  EMPTY_PLACE_ORDER_FORM,
  PLACE_ORDER_FIELDS,
  PLACE_ORDER_LIMITS as LIMITS,
  type PlaceOrderField,
  type PlaceOrderFormValues,
} from '@/lib/place-order-fields';

import type { WebSession } from './session';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';
import { rolesGuardAdmits } from './roles-guard';

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

export function canPlaceOrder(roles: readonly string[]): boolean {
  return rolesGuardAdmits(roles, PLACING_ROLES);
}

export function placeOrderFormValues(form: FormData): PlaceOrderFormValues {
  const values: Record<PlaceOrderField, string> = { ...EMPTY_PLACE_ORDER_FORM };
  for (const field of PLACE_ORDER_FIELDS) {
    const raw = form.get(field);
    if (typeof raw !== 'string') continue;
    // An id is compared, not read: it is trimmed and nothing else. A quantity
    // is typed on a Persian keyboard as often as not.
    values[field] = field === 'quantity' ? toLatinDigits(raw).trim() : raw.trim();
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
      .min(1, 'تعداد باید دست‌کم ۱ باشد')
      // Before `.int()`: 400 digits parse to Infinity, which is both too big and
      // not an integer, and the person should read the first (the limit).
      .max(
        LIMITS.quantity.max,
        `تعداد نباید بیش از ${toPersianDigits(String(LIMITS.quantity.max))} باشد`,
      )
      .int('تعداد را به‌صورت عدد صحیح وارد کنید'),
  );

const placeOrderSchema = z.object({
  // An id is picked from a list; anything with control or bidi characters is not
  // one, and is refused here rather than echoed back by the service.
  offerId: z
    .string()
    .min(1, 'پیشنهاد را انتخاب کنید')
    .max(64, 'پیشنهاد را انتخاب کنید')
    .refine(
      (value) => !BIDI_CONTROL.test(value) && !/\p{Cc}/u.test(value),
      'پیشنهاد را انتخاب کنید',
    ),
  quantity: quantitySchema,
});

export interface PlaceOrderRequest {
  readonly lines: readonly { readonly offerId: string; readonly quantity: number }[];
}

export type ParsedPlaceOrderForm =
  | { readonly ok: true; readonly request: PlaceOrderRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<PlaceOrderField, string>> };

export function parsePlaceOrderForm(values: PlaceOrderFormValues): ParsedPlaceOrderForm {
  const parsed = legacyParse(placeOrderSchema, values);
  if (!parsed.success) {
    return {
      ok: false,
      fieldErrors: firstIssuePerField(parsed.refusal, PLACE_ORDER_FIELDS),
    };
  }

  const { offerId, quantity } = parsed.data;
  return { ok: true, request: { lines: [{ offerId, quantity }] } };
}

export const PLACE_ORDER_FIELD_MAPPING: FieldMapping<PlaceOrderField> = {
  paths: {
    'lines[0].offerId': 'offerId',
    'lines[0].quantity': 'quantity',
  },
  messages: {
    'An organization cannot order from itself': 'سازمان شما نمی‌تواند از پیشنهاد خودش سفارش بدهد.',
    'An order must have a positive total': 'مجموع سفارش باید بیشتر از صفر باشد.',
    // Q-110: the service refuses an order note. The form never sends one (see
    // `parsePlaceOrderForm`: the body is `{ lines }` and nothing else); this is
    // only the Persian for a post that got past it.
    'An order note is not stored yet (open question Q-110); leave it out':
      'یادداشت سفارش هنوز ذخیره نمی‌شود؛ بدون یادداشت ثبت کنید.',
    'Missing Idempotency-Key': 'درخواست دوباره ارسال شد؛ صفحه را تازه کنید.',
  },
  byCode: {
    // The minimum or the available quantity, or a rule this portal has no
    // sentence for. Nothing was placed.
    BUSINESS_RULE_VIOLATION:
      'سفارش با شرایط کنونی این پیشنهاد جور نیست؛ کمینهٔ سفارش یا موجودی ممکن است عوض شده باشد. صفحه را تازه کنید و دوباره بسنجید.',
    CONFLICT:
      'با همین ارسال پیش‌تر سفارشی ثبت شده است. فهرست سفارش‌ها را ببینید، و اگر لازم است سفارش تازه‌ای بدهید.',
    IDEMPOTENCY_KEY_REUSED:
      'این فرم پیش‌تر با اطلاعات دیگری فرستاده شده بود و ممکن است سفارش ثبت شده باشد. فهرست سفارش‌ها را ببینید و اگر لازم بود سفارش تازه‌ای بدهید.',
    VALIDATION_FAILED: 'اطلاعات واردشده پذیرفته نشد؛ پیشنهاد و تعداد را بررسی کنید.',
  },
  // Never the service's own sentence: it is English and may echo input.
  fallback: 'سفارش با این اطلاعات پذیرفته نشد و ثبت نشد؛ پیشنهاد و تعداد را بررسی کنید.',
};

/** What the redirect needs of the placed order: only that it exists. */
const placedOrderSchema = z.object({ id: z.string().min(1) });

export type PlaceOrderResult = Exclude<
  WriteResult<z.infer<typeof placedOrderSchema>, PlaceOrderField>,
  { readonly kind: 'UNAVAILABLE' }
>;

/**
 * The service stores its idempotency response *after* its transaction, so a 5xx
 * can follow a committed order. On this write only a definite refusal (a 4xx with
 * a code, mapped above) means "not placed": every `UNAVAILABLE` — a 5xx, or a
 * status with no problem body — is unconfirmed.
 */
export async function placeOrder(
  session: WebSession,
  request: PlaceOrderRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<PlaceOrderResult> {
  const result = await writeThroughGateway(session, {
    path: '/v1/orders',
    body: request,
    submissionId,
    schema: placedOrderSchema,
    mapping: PLACE_ORDER_FIELD_MAPPING,
    fetchImpl,
  });
  if (result.kind === 'UNAVAILABLE') {
    return { kind: 'UNKNOWN_OUTCOME', correlationId: result.correlationId };
  }
  return result;
}
