import { z } from 'zod';
import { legacyParse } from '@rasta/contracts';

import { firstIssuePerField, formMessage } from './form-issues';
import { toLatinDigits, toPersianDigits } from './format';
import { SESSION_REFUSAL_MESSAGES } from './session-refusal';

/**
 * The demand screens' vocabulary (EXP-004, COM-007; procurement-service
 * `demand/dto.ts`, `demand.state-machine.ts`): the statuses, the create form,
 * how it is read, and the fixed Persian sentences every outcome is said in.
 * Client-safe: the form reads it to draw what it sends, and the server action
 * reads it again, so the request remembered and the request sent cannot differ.
 *
 * Wording: standard Persian orthography (hamza included, no U+0654); see
 * `orthography.spec.ts`.
 */

/** `DEMAND_STATES` of procurement-service (pinned by `demand-commands.contract.spec.ts`). */
export const DEMAND_STATUSES = ['SUBMITTED', 'WITHDRAWN', 'REFERRED', 'LAPSED'] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

export function isDemandStatus(value: unknown): value is DemandStatus {
  return typeof value === 'string' && (DEMAND_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Limits (procurement-service `demand/dto.ts`, pinned by the contract spec)
// ---------------------------------------------------------------------------

/** Marketplace's opaque product identifier; never checked there (Q-105, Q-120). */
export const PRODUCT_ID_PATTERN = /^PRD_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A PostgreSQL integer: the largest quantity one demand, and one window, holds. */
export const MAX_QUANTITY = 2_147_483_647;
/** In code points, as the service's schema and `char_length` count. */
export const MAX_NOTE_LENGTH = 500;

const BIDI_CONTROL = /\p{Bidi_Control}/u;

// ---------------------------------------------------------------------------
// The create form
// ---------------------------------------------------------------------------

export const DEMAND_FIELDS = ['productId', 'quantity', 'note'] as const;
export type DemandField = (typeof DEMAND_FIELDS)[number];
export type DemandFormValues = Readonly<Record<DemandField, string>>;
export const EMPTY_DEMAND_FORM: DemandFormValues = { productId: '', quantity: '', note: '' };

const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * One line ending: a browser posts a textarea's newlines as CRLF, the service
 * stores what it is sent. Canonical before the length rule, the digest and the
 * send, so the same note is the same request and the same length everywhere.
 */
export function canonicalLines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** The form as the action reads it, already in the one form it is compared and sent in. */
export function demandFormValues(form: FormData): DemandFormValues {
  return {
    productId: textOf(form, 'productId').trim(),
    quantity: toLatinDigits(textOf(form, 'quantity')).trim(),
    note: canonicalLines(textOf(form, 'note')).trim(),
  };
}

const fa = (value: number): string => toPersianDigits(String(value));

export const BIDI_CONTROL_MESSAGE = formMessage('این فیلد نویسه جهت‌دهی پنهان نمی‌پذیرد');

/** Code points, never UTF-16 units: the unit the service and its CHECK count. */
const codePoints = (value: string): number => [...value].length;

export const demandFormSchema = z
  .object({
    productId: z
      .string()
      .min(1, formMessage('شناسه کالا را بنویسید'))
      .regex(
        PRODUCT_ID_PATTERN,
        formMessage('شناسه کالا به شکل PRD_ و ۲۶ نویسه است؛ آن را از صفحه کالا در بازار بردارید'),
      ),
    quantity: z
      .string()
      .min(1, formMessage('مقدار را بنویسید'))
      .regex(/^[0-9]{1,10}$/, formMessage('مقدار یک عدد صحیح مثبت است'))
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .min(1, formMessage('مقدار دست‌کم ۱ است'))
          .max(MAX_QUANTITY, formMessage(`مقدار حداکثر ${fa(MAX_QUANTITY)} است`)),
      ),
    note: z
      .string()
      .refine(
        (value) => codePoints(value) <= MAX_NOTE_LENGTH,
        formMessage(`یادداشت حداکثر ${fa(MAX_NOTE_LENGTH)} نویسه است`),
      )
      .refine((value) => !BIDI_CONTROL.test(value), BIDI_CONTROL_MESSAGE),
  })
  .strict()
  // An empty note is not sent: omitted, never `""` (the service refuses an empty one).
  .transform(({ productId, quantity, note }) =>
    note === '' ? { productId, quantity } : { productId, quantity, note },
  );

export type DemandBody = z.output<typeof demandFormSchema>;

export type ParsedDemandForm =
  | { readonly ok: true; readonly body: DemandBody }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<DemandField, string>> };

export function parseDemandForm(values: DemandFormValues): ParsedDemandForm {
  const parsed = legacyParse(demandFormSchema, { ...values });
  if (parsed.success) return { ok: true, body: parsed.data };
  return { ok: false, fieldErrors: firstIssuePerField(parsed.refusal, DEMAND_FIELDS) };
}

// ---------------------------------------------------------------------------
// What the page says
// ---------------------------------------------------------------------------

/** What the detail page says once a submission is confirmed (the signed flash). */
export type DemandNotice = 'submitted';
export const DEMAND_NOTICES: readonly DemandNotice[] = ['submitted'];
export const DEMAND_NOTICE_TEXT: Readonly<Record<DemandNotice, string>> = {
  submitted: 'درخواست نیاز ثبت شد و به پنجره تجمیع باز همین کالا پیوست.',
};

/** What a submission does, and as truthfully what it does not (the controller's own description). */
export const DEMAND_SUBMIT_CONSEQUENCE =
  'نیاز برای سازمان فعال شما ثبت می‌شود و به پنجره تجمیع باز همین کالا می‌پیوندد، یا با نخستین نیاز پنجره تازه‌ای باز می‌کند. ' +
  'شناسه کالا در بازار بررسی نمی‌شود؛ آن را درست بنویسید. ویرایش ممکن نیست. ' +
  'یادداشت فقط برای سازمان شما خوانده می‌شود و در هیچ رویدادی منتشر نمی‌شود.';

/**
 * The closed `details[].code` of a refused submission (procurement-service
 * `shared/refusal.ts`, area `submission`), in fixed words: the service's
 * sentence is never shown.
 */
export const DEMAND_REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  AGGREGATION_QUANTITY_LIMIT_EXCEEDED:
    'با این مقدار، جمع پنجره تجمیع این کالا از بیشترین مقداری که یک سفارش می‌تواند داشته باشد می‌گذرد. چیزی ثبت نشد؛ مقدار کمتری بنویسید.',
  AGGREGATION_DEMAND_LIMIT_REACHED:
    'پنجره تجمیع این کالا به سقف شمار نیازها رسیده است و این نیاز ثبت نشد. پس از بسته شدن این پنجره دوباره ثبت کنید.',
};

/** 409 IDEMPOTENCY_KEY_REUSED: this form's key was already used for another request. */
export const KEY_REUSED_MESSAGE =
  'این فرم پیش‌تر با مقدارهای دیگری فرستاده شده است و چیزی ثبت نشد. نخست فهرست کامل نیازها را بررسی کنید، سپس صفحه را تازه کنید.';

export const DEMAND_INVALID_MESSAGE = 'مقدار واردشده با قواعد سامانه نمی‌خواند؛ آن را اصلاح کنید.';

export const DEMAND_FORBIDDEN_MESSAGE =
  'ثبت یا خواندن نیاز برای نقش شما در این سازمان مجاز نیست. نقش‌های مجاز را تنظیمات سرویس تدارکات تعیین می‌کند.';

export const DEMAND_FAILED_MESSAGE = 'انجام نشد و چیزی تغییر نکرد. می‌توانید دوباره بفرستید.';

/**
 * Said only for a write **proven** refused before it could act (a `4xx` with a
 * documented code, or a connection that never opened); a `5xx`, a timeout or a
 * reset is UNCONFIRMED and never reaches this.
 */
export function demandFailureText(status: number): string {
  if (status === 401) return SESSION_REFUSAL_MESSAGES.NO_SESSION;
  return DEMAND_FAILED_MESSAGE;
}

/** The form was left open past the time the service keeps its key: nothing was sent. */
export const DEMAND_EXPIRED_MESSAGE =
  'این فرم مدت زیادی باز مانده و دیگر فرستاده نمی‌شود، چون ممکن است فرستادن پیشین آن نیاز را ثبت کرده باشد. ' +
  'نخست فهرست کامل نیازها را بررسی کنید. اگر نیاز در فهرست نبود، صفحه را تازه کنید و دوباره ثبت کنید.';

/** An unresolved submission exists and this post carries other values. */
export const HELD_CHANGED_MESSAGE =
  'درخواست پیشین این فرم هنوز روشن نشده است و با مقدارهای دیگری فرستاده می‌شد. نمی‌توان آن را با مقدارهای تازه فرستاد: ' +
  'همان مقدارها را دوباره بفرستید، یا پس از بررسی فهرست کامل نیازها، با پذیرفتن خطر تکرار، درخواست تازه بفرستید.';

/** An unresolved submission exists and this post is another request. */
export const HELD_OTHER_MESSAGE =
  'درخواست پیشینی هنوز روشن نشده است و درخواست دیگری فرستاده نشد. صفحه را تازه کنید؛ ' +
  'نخست همان درخواست را بفرستید یا پس از بررسی فهرست کامل نیازها، با پذیرفتن خطر تکرار، درخواست تازه بفرستید.';

/** Another send of this form is in flight right now (another tab, a double press). */
export const HELD_IN_PROGRESS_MESSAGE =
  'درخواست دیگری از همین فرم هم‌اکنون در حال فرستاده شدن است (برای نمونه در زبانه دیگر)، پس چیزی فرستاده نشد. ' +
  'چند لحظه صبر کنید، صفحه را تازه کنید و وضعیت را ببینید.';

/** The store of unresolved requests could not be checked: nothing was sent. */
export const PENDING_UNCHECKED_MESSAGE =
  'اکنون نمی‌توان بررسی کرد که درخواست روشن‌نشده‌ای هست یا نه، پس چیزی فرستاده نشد و فرمی نشان داده نمی‌شود. ' +
  'چند لحظه بعد صفحه را تازه کنید.';

/** This login holds the most unresolved requests allowed. */
export const PENDING_CAPACITY_MESSAGE =
  'شمار درخواست‌های روشن‌نشده این نشست به سقف رسیده است و چیزی فرستاده نشد. ' +
  'نخست درخواست‌های روشن‌نشده را بررسی و رها کنید.';
