'use client';

import { useActionState, type ReactNode } from 'react';

import { Button, Field, controlClassName } from '@/ui';
import { formatMoney } from '@/lib/format';
import {
  DIRECT_COST_CATEGORIES,
  EMPTY_CANCEL_REPAIR_FORM,
  EMPTY_COMPLETE_REPAIR_FORM,
  EMPTY_RECORD_COST_FORM,
  EMPTY_RECORD_LABOUR_FORM,
  EMPTY_RECORD_PART_FORM,
  EMPTY_START_REPAIR_FORM,
  PART_SOURCES,
  type CancelRepairField,
  type CancelRepairFormValues,
  type CompleteRepairField,
  type CompleteRepairFormValues,
  type RecordCostField,
  type RecordCostFormValues,
  type RecordLabourField,
  type RecordLabourFormValues,
  type RecordPartField,
  type RecordPartFormValues,
  type StartRepairField,
  type StartRepairFormValues,
} from '@/lib/repair-order-fields';
import { costCategoryLabel, partSourceLabel } from '@/lib/labels';

import { CommandBanner, Hidden, submissionOf, type Identity } from './command-form-parts';
import { IDLE_COMMAND_FORM, type RequestCommandFormState } from './form-state';
import {
  submitCancelRepair,
  submitCompleteRepair,
  submitRecordCost,
  submitRecordLabour,
  submitRecordPart,
  submitStartRepair,
} from './repair-actions';

/**
 * The six commands on a repair order, as plain `<form>`s around server actions
 * so each works before any bundle has loaded (docs/16 § ۱۶٫۲).
 *
 * None of them names its order in a field. Each carries `baseline`, a token the
 * page signed for this command under this request (`sealRepairOrderBaseline`),
 * and the action reads the order from it; the form's own fields are only what a
 * person types. As for the request's forms, none of them says what the service
 * will do with a repeated post: the honest answer to a write that may or may not
 * have landed is `UnconfirmedWriteAlert`.
 */

export type RepairIdentity = Identity & {
  /** Signed for this command, this request and this person. */
  readonly baseline: string;
};

type State<V, F extends string> = RequestCommandFormState<V, F>;

const NUMBER_INPUT = { dir: 'ltr', inputMode: 'decimal', autoComplete: 'off' } as const;

/**
 * A form that stays closed until asked for — recording a charge is not what
 * most people open a repair for — and opens again when an attempt came back with
 * something to read.
 */
function Disclosure({
  summary,
  open,
  children,
}: {
  summary: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open ? true : undefined}>
      <summary className="cursor-pointer text-content underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
        {summary}
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export function StartRepairForm(identity: RepairIdentity) {
  const [state, action, pending] = useActionState<
    State<StartRepairFormValues, StartRepairField>,
    FormData
  >(submitStartRepair, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_START_REPAIR_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <CommandBanner state={state} forbidden="اجازهٔ آغاز تعمیر به شما داده نشده است." />

      <p className="text-sm text-content-muted">
        با آغاز تعمیر، ماشین از سرویس خارج می‌شود: دیگر به راننده سپرده نمی‌شود و وضعیت آن «در
        تعمیر» می‌شود.
      </p>

      <Field label="شرح کار (اختیاری)" error={errors.workSummary}>
        {(control) => (
          <textarea
            {...control}
            name="workSummary"
            rows={2}
            defaultValue={values.workSummary}
            maxLength={1000}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال آغاز…' : 'آغاز تعمیر'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Complete
// ---------------------------------------------------------------------------

export function CompleteRepairForm({
  totalCostMinor,
  ...identity
}: RepairIdentity & {
  /** The order total the screen above shows; it rides in the baseline, not in a field. */
  totalCostMinor: string;
}) {
  const [state, action, pending] = useActionState<
    State<CompleteRepairFormValues, CompleteRepairField>,
    FormData
  >(submitCompleteRepair, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_COMPLETE_REPAIR_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <form action={action} className="flex flex-col gap-4">
      <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
      <CommandBanner state={state} forbidden="اجازهٔ تکمیل تعمیر به شما داده نشده است." />

      <p className="text-content">
        با تکمیل، هزینهٔ این ارجاع <strong>{formatMoney(totalCostMinor)}</strong> بسته می‌شود و
        ماشین به سرویس برمی‌گردد. پس از آن، هزینهٔ تازه‌ای افزوده نمی‌شود و درخواست در انتظار تأیید
        شما می‌ماند.
      </p>

      <Field label="شرح کار انجام‌شده" required error={errors.workPerformed}>
        {(control) => (
          <textarea
            {...control}
            name="workPerformed"
            rows={3}
            defaultValue={values.workPerformed}
            maxLength={2000}
            className={controlClassName}
          />
        )}
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'در حال تکمیل…' : 'تکمیل تعمیر'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Withdraw the referral
// ---------------------------------------------------------------------------

export function CancelRepairForm(identity: RepairIdentity) {
  const [state, action, pending] = useActionState<
    State<CancelRepairFormValues, CancelRepairField>,
    FormData
  >(submitCancelRepair, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_CANCEL_REPAIR_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="پس‌گرفتن این ارجاع" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <CommandBanner state={state} forbidden="اجازهٔ لغو ارجاع به شما داده نشده است." />

        <p className="text-sm text-content-muted">
          درخواست باز می‌ماند و می‌توان آن را به تعمیرگاه دیگری ارجاع داد. هزینهٔ ثبت‌شده می‌ماند،
          چون واقعاً انجام شده است. این ارجاع نهایی لغو می‌شود.
        </p>

        <Field label="دلیل لغو" required error={errors.reason}>
          {(control) => (
            <textarea
              {...control}
              name="reason"
              rows={2}
              defaultValue={values.reason}
              maxLength={500}
              className={controlClassName}
            />
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" tone="secondary" disabled={pending}>
            {pending ? 'در حال لغو…' : 'پس‌گرفتن ارجاع'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// A part
// ---------------------------------------------------------------------------

export function RecordPartForm(identity: RepairIdentity) {
  const [state, action, pending] = useActionState<
    State<RecordPartFormValues, RecordPartField>,
    FormData
  >(submitRecordPart, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_RECORD_PART_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="ثبت قطعه" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <CommandBanner state={state} forbidden="اجازهٔ ثبت قطعه به شما داده نشده است." />

        <Field label="نام قطعه" required error={errors.partName}>
          {(control) => (
            <input
              {...control}
              name="partName"
              defaultValue={values.partName}
              maxLength={200}
              className={controlClassName}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="تعداد" required error={errors.quantity} hint="تا سه رقم اعشار">
            {(control) => (
              <input
                {...control}
                {...NUMBER_INPUT}
                name="quantity"
                defaultValue={values.quantity}
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="واحد" required error={errors.unit}>
            {(control) => (
              <input
                {...control}
                name="unit"
                defaultValue={values.unit}
                maxLength={32}
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="بهای هر واحد (ریال)" required error={errors.unitCostMinor}>
            {(control) => (
              <input
                {...control}
                {...NUMBER_INPUT}
                name="unitCostMinor"
                defaultValue={values.unitCostMinor}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="منبع قطعه" required error={errors.source}>
            {(control) => (
              <select
                {...control}
                name="source"
                defaultValue={values.source}
                className={controlClassName}
              >
                {PART_SOURCES.map((source) => (
                  <option key={source} value={source}>
                    {partSourceLabel(source)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="شناسهٔ قطعه" error={errors.partReference}>
            {(control) => (
              <input
                {...control}
                name="partReference"
                defaultValue={values.partReference}
                dir="ltr"
                autoComplete="off"
                maxLength={128}
                className={controlClassName}
              />
            )}
          </Field>
          <Field
            label="ارجاع منبع"
            error={errors.sourceReference}
            hint="شمارهٔ سفارش یا حواله در سامانهٔ صاحب آن"
          >
            {(control) => (
              <input
                {...control}
                name="sourceReference"
                defaultValue={values.sourceReference}
                dir="ltr"
                autoComplete="off"
                maxLength={128}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'ثبت قطعه'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Labour
// ---------------------------------------------------------------------------

export function RecordLabourForm(identity: RepairIdentity) {
  const [state, action, pending] = useActionState<
    State<RecordLabourFormValues, RecordLabourField>,
    FormData
  >(submitRecordLabour, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_RECORD_LABOUR_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="ثبت اجرت" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <CommandBanner state={state} forbidden="اجازهٔ ثبت اجرت به شما داده نشده است." />

        <Field label="شرح کار" required error={errors.description}>
          {(control) => (
            <input
              {...control}
              name="description"
              defaultValue={values.description}
              maxLength={500}
              className={controlClassName}
            />
          )}
        </Field>

        <Field
          label="نام تعمیرکار"
          error={errors.technician}
          hint="متن آزاد؛ تعمیرکار نیازی به حساب در سامانه ندارد"
        >
          {(control) => (
            <input
              {...control}
              name="technician"
              defaultValue={values.technician}
              maxLength={120}
              className={controlClassName}
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ساعت کار" required error={errors.hours} hint="تا دو رقم اعشار">
            {(control) => (
              <input
                {...control}
                {...NUMBER_INPUT}
                name="hours"
                defaultValue={values.hours}
                className={controlClassName}
              />
            )}
          </Field>
          <Field label="نرخ هر ساعت (ریال)" required error={errors.hourlyRateMinor}>
            {(control) => (
              <input
                {...control}
                {...NUMBER_INPUT}
                name="hourlyRateMinor"
                defaultValue={values.hourlyRateMinor}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'ثبت اجرت'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Any other cost
// ---------------------------------------------------------------------------

export function RecordCostForm(identity: RepairIdentity) {
  const [state, action, pending] = useActionState<
    State<RecordCostFormValues, RecordCostField>,
    FormData
  >(submitRecordCost, IDLE_COMMAND_FORM);

  const values = state.kind === 'INVALID' ? state.values : EMPTY_RECORD_COST_FORM;
  const errors = state.kind === 'INVALID' ? state.fieldErrors : {};

  return (
    <Disclosure summary="ثبت هزینهٔ دیگر" open={state.kind !== 'IDLE'}>
      <form action={action} className="flex flex-col gap-4">
        <Hidden {...identity} submissionId={submissionOf(state, identity.submissionId)} />
        <CommandBanner state={state} forbidden="اجازهٔ ثبت هزینه به شما داده نشده است." />

        <p className="text-sm text-content-muted">
          برای هزینه‌ای که قطعه یا اجرت نیست: حق‌الزحمهٔ آمدن، هزینهٔ عیب‌یابی، فاکتور شخص ثالث.
          قطعه و اجرت را با فرم خودشان ثبت کنید.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نوع هزینه" required error={errors.category}>
            {(control) => (
              <select
                {...control}
                name="category"
                defaultValue={values.category}
                className={controlClassName}
              >
                {DIRECT_COST_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {costCategoryLabel(category)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="مبلغ (ریال)" required error={errors.amountMinor}>
            {(control) => (
              <input
                {...control}
                {...NUMBER_INPUT}
                name="amountMinor"
                defaultValue={values.amountMinor}
                className={controlClassName}
              />
            )}
          </Field>
        </div>

        <Field label="شرح هزینه" required error={errors.description}>
          {(control) => (
            <input
              {...control}
              name="description"
              defaultValue={values.description}
              maxLength={500}
              className={controlClassName}
            />
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'در حال ثبت…' : 'ثبت هزینه'}
          </Button>
        </div>
      </form>
    </Disclosure>
  );
}
