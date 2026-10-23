import { normalizePersianText, toLatinDigits, toPersianDigits } from './format';
import {
  MAX_RETURN_LINES,
  MAX_RETURN_QUANTITY,
  REASON_FIELD,
  RETURN_REASON_MAX,
  RETURN_REASON_MIN,
  quantityField,
} from './return-fields';

/**
 * Reading the return-request form — client-safe, because the form remembers
 * exactly what it is about to send before it sends it
 * (`lib/unresolved-return.ts`), and the action reads the same form the same
 * way. One reader for both, so the remembered request and the sent request
 * cannot differ.
 *
 * The body is marketplace-service's `createReturnSchema`, and nothing else
 * (it is `.strict()`): a reason, and the order lines with how many of each.
 * No price, no refund amount — a return is not a refund (ADR-048 § 3).
 */

/** One line as `createReturnSchema` takes it. */
export interface ReturnLineRequest {
  readonly orderLineId: string;
  readonly quantity: number;
}

export interface ReturnRequestBody {
  readonly reason: string;
  readonly lines: readonly ReturnLineRequest[];
}

/** The form as typed: the reason, and each order line's quantity in the order drawn. */
export interface ReturnRequestValues {
  readonly reason: string;
  readonly quantities: readonly { readonly orderLineId: string; readonly quantity: string }[];
}

/** An order line the form offers, and how many of it may still be asked for, when known. */
export interface ReturnableLine {
  readonly orderLineId: string;
  /** Sold, less what open requests already take; null when the page could not tell. */
  readonly available: number | null;
}

export type ReturnRequestErrors = Partial<Record<string, string>>;

export type ParsedReturnRequest =
  | { readonly ok: true; readonly body: ReturnRequestBody }
  | {
      readonly ok: false;
      readonly fieldErrors: ReturnRequestErrors;
      readonly message: string | null;
    };

/** What `plainText()` refuses in the reason (`@rasta/contracts`, `WITHOUT_BIDI_CONTROL`). */
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/** An order line id as this form names it: never parsed, only bounded. */
const ORDER_LINE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const QUANTITY_PREFIX = quantityField('');

const digits = (value: number): string => toPersianDigits(String(value));

export const RETURN_REQUEST_MESSAGES = {
  reasonShort: `دلیل بازگشت را دست‌کم در ${digits(RETURN_REASON_MIN)} نویسه بنویسید — تأمین‌کننده باید بداند موضوع چیست.`,
  reasonLong: `دلیل نباید بیش از ${digits(RETURN_REASON_MAX)} نویسه باشد.`,
  characters: 'دلیل بازگشت نویسه‌های کنترلی جهت‌نما نمی‌پذیرد.',
  noLine: 'دست‌کم برای یک ردیف تعدادی بیشتر از صفر بنویسید.',
  tooManyLines: `یک درخواست حداکثر ${digits(MAX_RETURN_LINES)} ردیف دارد.`,
  quantity: 'تعداد را به‌صورت عدد صحیح مثبت بنویسید، یا خالی بگذارید.',
  unknownLine: 'این ردیف از ردیف‌های این سفارش نیست.',
} as const;

export function exceedsMessage(available: number): string {
  return available === 0
    ? 'از این ردیف چیزی برای بازگرداندن نمانده است.'
    : `از این ردیف حداکثر ${digits(available)} واحد را می‌توان بازگرداند.`;
}

/** The form's values, in the order drawn. */
export function returnRequestFormValues(form: FormData): ReturnRequestValues {
  const reason = form.get(REASON_FIELD);
  const quantities: { orderLineId: string; quantity: string }[] = [];
  for (const [name, value] of form.entries()) {
    if (!name.startsWith(QUANTITY_PREFIX) || typeof value !== 'string') continue;
    quantities.push({ orderLineId: name.slice(QUANTITY_PREFIX.length), quantity: value });
  }
  return { reason: typeof reason === 'string' ? reason : '', quantities };
}

/**
 * The values, into exactly the body `createReturnSchema` accepts. A line left
 * blank or at zero is not part of the request. `lines`, when given, are the
 * order's own lines with what each still allows; the server action passes
 * null and leaves both checks to marketplace-service, which makes them again
 * under the order's lock either way.
 */
export function parseReturnRequest(
  values: ReturnRequestValues,
  lines: readonly ReturnableLine[] | null,
): ParsedReturnRequest {
  const fieldErrors: ReturnRequestErrors = {};

  const reason = normalizePersianText(values.reason).trim();
  if (BIDI_CONTROL.test(reason)) fieldErrors[REASON_FIELD] = RETURN_REQUEST_MESSAGES.characters;
  else if (reason.length < RETURN_REASON_MIN)
    fieldErrors[REASON_FIELD] = RETURN_REQUEST_MESSAGES.reasonShort;
  else if (reason.length > RETURN_REASON_MAX)
    fieldErrors[REASON_FIELD] = RETURN_REQUEST_MESSAGES.reasonLong;

  const known = lines === null ? null : new Map(lines.map((line) => [line.orderLineId, line]));
  const requested: ReturnLineRequest[] = [];
  const seen = new Set<string>();
  for (const { orderLineId, quantity } of values.quantities) {
    const field = quantityField(orderLineId);
    const typed = toLatinDigits(quantity).trim();
    if (!ORDER_LINE_ID.test(orderLineId) || seen.has(orderLineId)) {
      return { ok: false, fieldErrors, message: RETURN_REQUEST_MESSAGES.unknownLine };
    }
    seen.add(orderLineId);
    const line = known?.get(orderLineId);
    if (known !== null && line === undefined) {
      return { ok: false, fieldErrors, message: RETURN_REQUEST_MESSAGES.unknownLine };
    }
    if (typed === '' || /^0+$/.test(typed)) continue;
    if (!/^[1-9][0-9]{0,6}$/.test(typed) || Number(typed) > MAX_RETURN_QUANTITY) {
      fieldErrors[field] = RETURN_REQUEST_MESSAGES.quantity;
      continue;
    }
    const count = Number(typed);
    if (line?.available !== null && line?.available !== undefined && count > line.available) {
      fieldErrors[field] = exceedsMessage(line.available);
      continue;
    }
    requested.push({ orderLineId, quantity: count });
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors, message: null };
  if (requested.length === 0) {
    return { ok: false, fieldErrors, message: RETURN_REQUEST_MESSAGES.noLine };
  }
  if (requested.length > MAX_RETURN_LINES) {
    return { ok: false, fieldErrors, message: RETURN_REQUEST_MESSAGES.tooManyLines };
  }
  return { ok: true, body: { reason, lines: requested } };
}

/** A kept request as the form's values again, for the hidden fields of a retry. */
export function valuesOfBody(body: ReturnRequestBody): ReturnRequestValues {
  return {
    reason: body.reason,
    quantities: body.lines.map((line) => ({
      orderLineId: line.orderLineId,
      quantity: String(line.quantity),
    })),
  };
}
