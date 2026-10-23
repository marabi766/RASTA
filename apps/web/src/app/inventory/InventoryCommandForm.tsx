'use client';

import { useActionState, useCallback, useState } from 'react';

import { Alert, Button, Field, controlClassName } from '@/ui';
import { toPersianDigits } from '@/lib/format';
import { CSRF_FIELD, REPLAY_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import {
  AMOUNT_FIELD,
  CONSIGNEE_FIELD,
  DIRECTIONS,
  DIRECTION_FIELD,
  DIRECTION_LABELS,
  INVENTORY_COMMAND_CONSEQUENCES,
  INVENTORY_COMMAND_LABELS,
  INVENTORY_FORBIDDEN_TEXT,
  INVENTORY_NOT_FOUND_TEXT,
  LATITUDE_FIELD,
  LONGITUDE_FIELD,
  MAX_SHIPMENT_LEGS,
  NAME_FIELD,
  ORDER_FIELD,
  PRODUCT_FIELD,
  QUANTITY_FIELD,
  SOURCE_FIELD,
  STOCK_ITEM_FIELD,
  hasFields,
  inventoryFormValues,
  legField,
  parseInventoryForm,
  valuesOfBody,
  type InventoryCommand,
  type InventoryFormValues,
  type InventoryScope,
} from '@/lib/inventory-commands';
import { formatQuantity } from '@/lib/inventory-fields';
import { isRedirect, sessionHasEnded, SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import type { Binding } from '@/lib/unresolved-order';
import {
  clearUnresolvedInventory,
  restoreUnresolvedInventory,
  saveUnresolvedInventory,
  type ReplayStamp,
  type RestoredInventory,
} from '@/lib/unresolved-inventory';

import { submitInventoryCommand } from './inventory-actions';
import {
  IDLE_INVENTORY_FORM,
  withRetryNote,
  type InventoryFormState,
  type UnconfirmedInventory,
} from './inventory-form-state';

/**
 * One inventory command this viewer may issue — a warehouse, a receipt, an
 * adjustment, a shipment, or one move of a shipment. The page draws one per
 * command `server/inventory-commands.ts` says the service would accept, so
 * this component never decides whether the command is allowed, only what its
 * form looks like. Each instance has its own submission id — the idempotency
 * key inventory-service replays on — and its own signed replay stamp.
 *
 * ## Sent and not confirmed
 *
 * The submission is remembered before it leaves (`lib/unresolved-inventory.ts`),
 * the form is replaced by a view that never says "nothing changed", and "send
 * the same request again" re-sends the kept body under the kept key — a typed
 * command's fields as they were sent; a shipment move's body is in the stamp.
 * A confirmed answer redirects and drops the entry; otherwise only the person
 * drops it, once the same request has been tried again or can no longer be.
 *
 * ## One unresolved command per slot
 *
 * A warehouse's receipt, adjustment and new-shipment forms share one slot, a
 * shipment's two moves another. While another submission's outcome is unknown
 * (`heldBy`, kept current by `InventoryCommands`), this form draws no button,
 * only the uncertainty notice; and a send is refused here, before anything
 * leaves, whenever the slot holds another submission. A record is cleared only
 * for the submission it belongs to.
 *
 * ## When the call itself fails
 *
 * Only `/auth/session` answering `401` lets the view say the session has
 * ended; any other failure is "no answer came back", and the same request may
 * still be sent.
 */

/** A stock item the adjustment form offers. */
export interface AdjustableItem {
  readonly id: string;
  readonly productId: string;
  readonly onHandQuantity: number;
  readonly reservedQuantity: number;
}

export interface InventoryCommandFormProps {
  readonly scope: InventoryScope;
  readonly command: InventoryCommand;
  readonly csrfToken: string;
  readonly submissionId: string;
  /** That submission id's signed replay deadline; null for a restored entry that has none any more. */
  readonly replay: ReplayStamp | null;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The stock items an adjustment may name; adjustments only. */
  readonly items?: readonly AdjustableItem[];
  /** The page that shows the outcome — reloaded to see whether the command took. */
  readonly pageHref: string;
  readonly initial?: InventoryFormState;
  /** The submission whose outcome is unknown in this slot, if any (`InventoryCommands`). */
  readonly heldBy?: string | null;
}

/** The remembered submission as the form's starting state. */
export function unconfirmedFrom(restored: RestoredInventory): UnconfirmedInventory {
  const { command, correlationId, submissionId, body, replay, marker } = restored.entry;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId,
    submissionId,
    body,
    replay,
    ...(restored.kind === 'VIEW_ONLY' ? { viewOnly: true as const } : {}),
    ...(marker ? { marker: true as const } : {}),
  };
}

/** The submission as the action will send it, or null when the action would refuse it unsent. */
function pendingFrom(
  form: FormData,
  command: InventoryCommand,
  replay: ReplayStamp | null,
): UnconfirmedInventory | null {
  const submissionId = form.get(SUBMISSION_FIELD);
  if (typeof submissionId !== 'string') return null;
  if (!hasFields(command)) {
    return { kind: 'UNCONFIRMED', command, correlationId: null, submissionId, body: null, replay };
  }
  // The same reading the action makes, so what is kept is what is sent.
  const parsed = parseInventoryForm(command, inventoryFormValues(form));
  if (!parsed.ok) return null;
  return {
    kind: 'UNCONFIRMED',
    command,
    correlationId: null,
    submissionId,
    body: parsed.body,
    replay,
  };
}

export function InventoryCommandForm({
  scope,
  command,
  csrfToken,
  submissionId,
  replay,
  binding,
  sessionMaxAgeSeconds,
  items = [],
  pageHref,
  initial = IDLE_INVENTORY_FORM,
  heldBy = null,
}: InventoryCommandFormProps) {
  const send = useCallback(
    async (previous: InventoryFormState, form: FormData): Promise<InventoryFormState> => {
      const firstSend = previous.kind !== 'UNCONFIRMED';
      const sent = form.get(SUBMISSION_FIELD);
      const sentId = firstSend ? (typeof sent === 'string' ? sent : '') : previous.submissionId;
      if (firstSend) {
        // A typed command checked here first, before it is remembered or sent.
        if (hasFields(command)) {
          const values = inventoryFormValues(form);
          const parsed = parseInventoryForm(command, values);
          if (!parsed.ok) {
            return {
              kind: 'INVALID',
              command,
              submissionId: sentId,
              values,
              fieldErrors: parsed.fieldErrors,
              message: parsed.message,
            };
          }
        }
        // Another submission's outcome is unknown here: nothing is sent, and its
        // record is not touched.
        const holder = restoreUnresolvedInventory(scope, binding, sessionMaxAgeSeconds);
        if (holder && holder.entry.submissionId !== sentId) return { kind: 'HELD' };
      } else {
        // A replay only while the service still holds its key, and only from
        // the login it is bound to. Past that, never re-sent.
        const stored = restoreUnresolvedInventory(scope, binding, sessionMaxAgeSeconds);
        if (stored?.kind !== 'RETRYABLE' || stored.entry.submissionId !== previous.submissionId) {
          return { ...previous, viewOnly: true };
        }
      }

      // Remembered BEFORE it is sent; not sent if it cannot be remembered.
      const unsent = firstSend ? pendingFrom(form, command, replay) : null;
      const saved = unsent ? saveUnresolvedInventory(scope, unsent, binding) : null;
      if (saved === 'HELD') return { kind: 'HELD' };
      if (saved === 'UNAVAILABLE') return { kind: 'STORAGE_UNAVAILABLE' };

      let next: InventoryFormState;
      try {
        next = await submitInventoryCommand(scope, previous, form);
      } catch (error) {
        // Done: the action redirects to the warehouse or the shipment.
        if (isRedirect(error)) {
          clearUnresolvedInventory(scope, sentId);
          throw error;
        }
        const ended = await sessionHasEnded();
        if (!firstSend) return withRetryNote(previous, ended ? 'sessionEnded' : 'retryUnknown');
        if (unsent) return ended ? { ...unsent, sessionEnded: true } : unsent;
        throw error;
      }

      // Still in doubt: kept. A definite answer to THIS submission's first send:
      // its own record is dropped — never another's.
      if (next.kind === 'UNCONFIRMED') saveUnresolvedInventory(scope, next, binding);
      else if (firstSend) clearUnresolvedInventory(scope, sentId);
      return next;
    },
    [scope, command, replay, binding, sessionMaxAgeSeconds],
  );
  const [state, action, pending] = useActionState(send, initial);
  const headingId = `inventory-command-${command}`;

  if (state.kind === 'UNCONFIRMED') {
    return (
      <UnconfirmedCommand
        state={state}
        action={action}
        pending={pending}
        csrfToken={csrfToken}
        headingId={headingId}
        pageHref={pageHref}
        onForget={() => clearUnresolvedInventory(scope, state.submissionId)}
      />
    );
  }

  const invalid = state.kind === 'INVALID';
  const currentSubmissionId = invalid ? state.submissionId : submissionId;

  if (heldBy !== null && heldBy !== currentSubmissionId) {
    return <HeldCommand command={command} headingId={headingId} pageHref={pageHref} />;
  }

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={currentSubmissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={replay?.token ?? ''} />

      <h3 id={headingId} className="text-base font-medium">
        {INVENTORY_COMMAND_LABELS[command]}
      </h3>
      <p className="text-sm text-content-muted">{INVENTORY_COMMAND_CONSEQUENCES[command]}</p>

      <CommandBanner state={state} />

      <CommandFields
        command={command}
        items={items}
        values={invalid ? state.values : null}
        fieldErrors={invalid ? state.fieldErrors : {}}
      />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال ارسال…' : INVENTORY_COMMAND_LABELS[command]}
        </Button>
      </div>
    </form>
  );
}

type Errors = Partial<Record<string, string>>;

function CommandFields({
  command,
  items,
  values,
  fieldErrors,
}: {
  command: InventoryCommand;
  items: readonly AdjustableItem[];
  values: InventoryFormValues | null;
  fieldErrors: Errors;
}) {
  const typed = (name: string): string => values?.[name] ?? '';
  switch (command) {
    case 'CREATE_WAREHOUSE':
      return (
        <>
          <Field label="نام انبار" error={fieldErrors[NAME_FIELD]} required>
            {(control) => (
              <input
                {...control}
                name={NAME_FIELD}
                autoComplete="off"
                defaultValue={typed(NAME_FIELD)}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="عرض جغرافیایی"
            hint="اختیاری؛ عددی بین ۹۰- و ۹۰. فقط برای دیدن شما نگه داشته می‌شود."
            error={fieldErrors[LATITUDE_FIELD]}
          >
            {(control) => (
              <input
                {...control}
                name={LATITUDE_FIELD}
                inputMode="decimal"
                autoComplete="off"
                dir="ltr"
                defaultValue={typed(LATITUDE_FIELD)}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="طول جغرافیایی"
            hint="اختیاری؛ عددی بین ۱۸۰- و ۱۸۰."
            error={fieldErrors[LONGITUDE_FIELD]}
          >
            {(control) => (
              <input
                {...control}
                name={LONGITUDE_FIELD}
                inputMode="decimal"
                autoComplete="off"
                dir="ltr"
                defaultValue={typed(LONGITUDE_FIELD)}
                className={controlClassName}
              />
            )}
          </Field>
        </>
      );
    case 'RECEIVE_STOCK':
      return (
        <>
          <Field
            label="شناسه کالا"
            hint="به شکل PRD_ و ۲۶ نویسه؛ سامانه انبار نام کالا را نمی‌شناسد."
            error={fieldErrors[PRODUCT_FIELD]}
            required
          >
            {(control) => (
              <input
                {...control}
                name={PRODUCT_FIELD}
                autoComplete="off"
                dir="ltr"
                defaultValue={typed(PRODUCT_FIELD)}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="تعداد دریافتی"
            hint="عدد صحیح مثبت، به واحد پایه کالا."
            error={fieldErrors[QUANTITY_FIELD]}
            required
          >
            {(control) => (
              <input
                {...control}
                name={QUANTITY_FIELD}
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                defaultValue={typed(QUANTITY_FIELD)}
                className={controlClassName}
              />
            )}
          </Field>
          <SourceField error={fieldErrors[SOURCE_FIELD]} defaultValue={typed(SOURCE_FIELD)} />
        </>
      );
    case 'ADJUST_STOCK':
      return (
        <>
          <Field label="کالا" error={fieldErrors[STOCK_ITEM_FIELD]} required>
            {(control) => (
              <select
                {...control}
                name={STOCK_ITEM_FIELD}
                defaultValue={typed(STOCK_ITEM_FIELD)}
                className={controlClassName}
              >
                <option value="">— برگزینید —</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.productId} — موجود {formatQuantity(item.onHandQuantity)}، رزروشده{' '}
                    {formatQuantity(item.reservedQuantity)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="نوع تغییر" error={fieldErrors[DIRECTION_FIELD]} required>
            {(control) => (
              <select
                {...control}
                name={DIRECTION_FIELD}
                defaultValue={typed(DIRECTION_FIELD)}
                className={controlClassName}
              >
                <option value="">— برگزینید —</option>
                {DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {DIRECTION_LABELS[direction]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="مقدار"
            hint="عدد صحیح مثبت؛ جهت تغییر را بالا برگزیدید."
            error={fieldErrors[AMOUNT_FIELD]}
            required
          >
            {(control) => (
              <input
                {...control}
                name={AMOUNT_FIELD}
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                defaultValue={typed(AMOUNT_FIELD)}
                className={controlClassName}
              />
            )}
          </Field>
          <SourceField error={fieldErrors[SOURCE_FIELD]} defaultValue={typed(SOURCE_FIELD)} />
        </>
      );
    case 'CREATE_SHIPMENT':
      return <ShipmentFields values={values} fieldErrors={fieldErrors} />;
    case 'DISPATCH_SHIPMENT':
    case 'DELIVER_SHIPMENT':
      return null;
  }
}

/** The optional reference of the document a stock movement comes from. */
function SourceField({ error, defaultValue }: { error?: string; defaultValue: string }) {
  return (
    <Field
      label="مرجع سند"
      hint="اختیاری: ORD_ یا PO_ یا ADJ_ و ۲۶ نویسه. همراه حرکت ثبت می‌شود و بررسی نمی‌شود."
      error={error}
    >
      {(control) => (
        <input
          {...control}
          name={SOURCE_FIELD}
          autoComplete="off"
          dir="ltr"
          defaultValue={defaultValue}
          className={controlClassName}
        />
      )}
    </Field>
  );
}

/** How many leg rows a form starts with: the ones it was drawn again with, at least one. */
function initialLegCount(values: InventoryFormValues | null): number {
  if (values === null) return 1;
  let count = 1;
  for (const name of Object.keys(values)) {
    const match = /^leg\.(\d{1,2})\./.exec(name);
    if (match) count = Math.max(count, Number(match[1]) + 1);
  }
  return Math.min(count, MAX_SHIPMENT_LEGS);
}

function ShipmentFields({
  values,
  fieldErrors,
}: {
  values: InventoryFormValues | null;
  fieldErrors: Errors;
}) {
  const [legs, setLegs] = useState(() => initialLegCount(values));
  const typed = (name: string): string => values?.[name] ?? '';
  return (
    <>
      <Field
        label="سازمان گیرنده"
        hint="شناسه سازمان، به شکل ORG_ و ۲۶ نویسه. گیرنده می‌تواند محموله را ببیند، نه جابه‌جا کند."
        error={fieldErrors[CONSIGNEE_FIELD]}
        required
      >
        {(control) => (
          <input
            {...control}
            name={CONSIGNEE_FIELD}
            autoComplete="off"
            dir="ltr"
            defaultValue={typed(CONSIGNEE_FIELD)}
            className={controlClassName}
          />
        )}
      </Field>
      <Field
        label="مرجع سفارش"
        hint="اختیاری: ORD_ یا PO_ و ۲۶ نویسه."
        error={fieldErrors[ORDER_FIELD]}
      >
        {(control) => (
          <input
            {...control}
            name={ORDER_FIELD}
            autoComplete="off"
            dir="ltr"
            defaultValue={typed(ORDER_FIELD)}
            className={controlClassName}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">مرحله‌های حمل، به ترتیب</legend>
        <p className="text-sm text-content-muted">
          یک تا {toPersianDigits(String(MAX_SHIPMENT_LEGS))} مرحله؛ پس از ایجاد محموله تغییر
          نمی‌کنند.
        </p>
        {Array.from({ length: legs }, (_unused, index) => (
          <div key={index} className="flex flex-col gap-3 rounded-md border border-border p-3">
            <Field
              label={`حمل‌کننده مرحله ${toPersianDigits(String(index + 1))}`}
              error={fieldErrors[legField(index, 'carrierName')]}
              required={index === 0}
            >
              {(control) => (
                <input
                  {...control}
                  name={legField(index, 'carrierName')}
                  autoComplete="off"
                  defaultValue={typed(legField(index, 'carrierName'))}
                  className={controlClassName}
                />
              )}
            </Field>
            <Field
              label={`شماره پیگیری مرحله ${toPersianDigits(String(index + 1))}`}
              hint="اختیاری: شماره بارنامه یا پیگیری خود حمل‌کننده."
              error={fieldErrors[legField(index, 'carrierReference')]}
            >
              {(control) => (
                <input
                  {...control}
                  name={legField(index, 'carrierReference')}
                  autoComplete="off"
                  dir="ltr"
                  defaultValue={typed(legField(index, 'carrierReference'))}
                  className={controlClassName}
                />
              )}
            </Field>
          </div>
        ))}
        <div className="flex gap-3">
          {legs < MAX_SHIPMENT_LEGS ? (
            <Button type="button" tone="secondary" onClick={() => setLegs(legs + 1)}>
              افزودن مرحله حمل
            </Button>
          ) : null}
          {legs > 1 ? (
            <Button type="button" tone="secondary" onClick={() => setLegs(legs - 1)}>
              حذف آخرین مرحله
            </Button>
          ) : null}
        </div>
      </fieldset>
    </>
  );
}

/** Nothing was sent in any of these. */
const REFUSAL_MESSAGES: Record<Extract<InventoryFormState, { kind: 'REFUSED' }>['reason'], string> =
  {
    ...SESSION_REFUSAL_MESSAGES,
    REPLAY: 'مهلت این فرم گذشته است و درخواست ارسال نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
    CSRF: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
    SUBMISSION: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
    COMMAND: 'این درخواست معتبر شناخته نشد. صفحه را تازه کنید و دوباره تلاش کنید.',
  };

export const HELD_MESSAGE =
  'درخواست دیگری درباره همین انبار یا محموله فرستاده شده و نتیجه آن هنوز معلوم نیست؛ ممکن است انجام شده باشد. تا روشن شدن نتیجه آن، این فرم فرستاده نمی‌شود. وضعیت را با تازه کردن صفحه ببینید.';

/**
 * Another command of this slot is unresolved: no form, no button — only what
 * this command would be, and why it waits.
 */
function HeldCommand({
  command,
  headingId,
  pageHref,
}: {
  command: InventoryCommand;
  headingId: string;
  pageHref: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h3 id={headingId} className="text-base font-medium">
        {INVENTORY_COMMAND_LABELS[command]}
      </h3>
      <Alert tone="warning">
        {HELD_MESSAGE}{' '}
        <a href={pageHref} className="underline">
          تازه کردن صفحه
        </a>
      </Alert>
    </section>
  );
}

function CommandBanner({ state }: { state: InventoryFormState }) {
  if (state.kind === 'HELD') {
    return <Alert tone="warning">{HELD_MESSAGE}</Alert>;
  }
  if (state.kind === 'INVALID' && state.message) {
    return <Alert tone="warning">{state.message}</Alert>;
  }
  if (state.kind === 'REFUSED') {
    return <Alert tone="danger">{REFUSAL_MESSAGES[state.reason]}</Alert>;
  }
  if (state.kind === 'FORBIDDEN') {
    return (
      <Alert tone="danger">
        {INVENTORY_FORBIDDEN_TEXT} کد پیگیری: {state.correlationId}
      </Alert>
    );
  }
  if (state.kind === 'NOT_FOUND') {
    return <Alert tone="warning">{INVENTORY_NOT_FOUND_TEXT}</Alert>;
  }
  if (state.kind === 'STORAGE_UNAVAILABLE') {
    return (
      <Alert tone="danger">
        درخواست ارسال نشد: این مرورگر نمی‌تواند درخواست را تا روشن شدن نتیجه آن به خاطر بسپارد (مثلا
        حالت خصوصی یا حافظه پر)، و بی آن ممکن است موجودی یا محموله دو بار ثبت شود. از مرورگر دیگری
        استفاده کنید یا فضا را آزاد کنید و دوباره تلاش کنید.
      </Alert>
    );
  }
  return null;
}

/**
 * Sent, maybe done, not confirmed. The retry re-sends the kept body under the
 * kept submission id; the page, reloaded, is the reference.
 */
function UnconfirmedCommand({
  state,
  action,
  pending,
  csrfToken,
  headingId,
  pageHref,
  onForget,
}: {
  state: UnconfirmedInventory;
  action: (form: FormData) => void;
  pending: boolean;
  csrfToken: string;
  headingId: string;
  pageHref: string;
  onForget: () => void;
}) {
  const canRetry = !state.viewOnly && !state.sessionEnded;
  const canForget = (state.viewOnly || state.retryRefused) && !state.sessionEnded;
  const what = INVENTORY_COMMAND_LABELS[state.command];
  const kept = state.body ? valuesOfBody(state.command, state.body) : null;

  return (
    <form
      action={action}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
    >
      <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
      <input type="hidden" name={SUBMISSION_FIELD} value={state.submissionId} />
      <input type="hidden" name={REPLAY_FIELD} value={state.replay?.token ?? ''} />
      {kept ? (
        <span hidden>
          {Object.entries(kept).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
        </span>
      ) : null}

      <h3 id={headingId} className="text-base font-medium">
        {what}
      </h3>
      <Alert tone="warning">
        نتوانستیم تایید کنیم که «{what}» انجام شد یا نه؛ ممکن است انجام شده باشد. پیش از هر کار
        دیگر،{' '}
        <a href={pageHref} className="underline">
          این صفحه را تازه کنید
        </a>{' '}
        و موجودی، حرکت‌ها و محموله‌ها را ببینید.
        {state.correlationId ? ` کد پیگیری: ${state.correlationId}` : ''}
      </Alert>
      {state.retryRefused ? (
        <Alert tone="warning">
          ارسال دوباره رد شد و نتیجه درخواست نخست همچنان معلوم نیست؛ ممکن است انجام شده باشد. با
          تازه کردن صفحه وضعیت را ببینید.
        </Alert>
      ) : null}
      {state.retryUnknown ? (
        <Alert tone="warning">
          ارسال دوباره نیز نتیجه روشنی نداشت و وضعیت درخواست نخست همچنان معلوم نیست؛ ممکن است انجام
          شده باشد. با تازه کردن صفحه وضعیت را ببینید.
        </Alert>
      ) : null}
      {state.sessionEnded ? (
        <Alert tone="danger">
          نشست شما پایان یافته است. دوباره وارد شوید و پیش از هر اقدام تازه وضعیت را ببینید؛ ممکن
          است درخواست انجام شده باشد.
        </Alert>
      ) : null}
      {state.marker ? (
        <Alert tone="warning">
          نتیجه این درخواست هنوز معلوم نیست و محتوای آن دیگر نگه داشته نمی‌شود؛ ممکن است انجام شده
          باشد. پیش از هر اقدام تازه، وضعیت را ببینید.
        </Alert>
      ) : state.replayExpired ? (
        <Alert tone="warning">
          مهلت ارسال دوباره همین درخواست گذشته است و چیزی فرستاده نشد؛ نتیجه درخواست نخست همچنان
          معلوم نیست و ممکن است انجام شده باشد. وضعیت را ببینید.
        </Alert>
      ) : state.viewOnly ? (
        <Alert tone="warning">
          این درخواست در نشست پیشین فرستاده شده یا مهلت ارسال دوباره آن گذشته است و دیگر نمی‌توان
          همان را با اطمینان دوباره فرستاد؛ ممکن است انجام شده باشد. وضعیت را ببینید.
        </Alert>
      ) : null}
      {canRetry ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ارسال…' : 'ارسال دوباره همین درخواست'}
          </Button>
        </div>
      ) : null}
      {canForget ? (
        <div>
          {/* A full navigation: the page reads the warehouse or shipment again and offers what it allows. */}
          <a href={pageHref} onClick={onForget} onAuxClick={onForget} className="text-sm underline">
            وضعیت را دیدم؛ این درخواست را کنار بگذار
          </a>
        </div>
      ) : null}
      <p className="text-sm text-content-muted">
        {canRetry
          ? '«ارسال دوباره» همان درخواست را با همان شناسه ارسال و همان محتوا می‌فرستد و سرویس انبار همان پاسخ نخست را برمی‌گرداند و کاری را دوباره انجام نمی‌دهد، تا زمانی که شناسه را نگه داشته است؛ وضعیت ثبت‌شده مرجع است. تا روشن شدن نتیجه، اقدام تازه‌ای اینجا عرضه نمی‌شود.'
          : 'وضعیت ثبت‌شده مرجع است.'}
      </p>
    </form>
  );
}
