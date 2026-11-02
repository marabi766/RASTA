/**
 * @jest-environment node
 */
import { EMPTY_REGISTER_ASSET_FORM } from '@/lib/asset-form-fields';
import { EMPTY_CHANGE_STATUS_FORM } from '@/lib/asset-lifecycle-fields';
import { parseRegisterAssetForm } from './asset-commands';
import { parseChangeStatusForm } from './asset-lifecycle-commands';
import { parsePlaceOrderForm } from './place-order';
import { parseReportRequestForm } from './maintenance-commands';
import { parseUsageForm } from './usage';

/**
 * Differential goldens for the portal's adapter of a zod refusal, the Persian
 * message per field (PR #444 r1 F1), through the form parsers the server
 * actions call. Each `ZOD3` value was recorded by running this file unchanged
 * on main `745d0434` (zod 3.25.76) (`~/worker2/session/t109/scripts/record.sh`).
 */

/** Recorded under zod 3 on main 745d0434; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'register empty': {
    ok: false,
    fieldErrors: { name: 'نام دست‌کم ۲ نویسه باشد', type: 'نوع ماشین را انتخاب کنید' },
  },
  'register year 0.5': {
    ok: false,
    fieldErrors: {
      type: 'نوع ماشین را انتخاب کنید',
      manufactureYear: 'سال ساخت باید عددی چهاررقمی بین ۱۳۰۰ و ۲۱۰۰ باشد',
    },
  },
  'register year 1e999': {
    ok: false,
    fieldErrors: {
      type: 'نوع ماشین را انتخاب کنید',
      manufactureYear: 'سال ساخت باید عددی چهاررقمی بین ۱۳۰۰ و ۲۱۰۰ باشد',
    },
  },
  'register type outside its enum': {
    ok: false,
    fieldErrors: { type: 'نوع ماشین را انتخاب کنید' },
  },
  'status empty': {
    ok: false,
    fieldErrors: { status: 'وضعیت تازه را از فهرست انتخاب کنید', reason: 'دلیل تغییر را بنویسید' },
  },
  'status status outside its enum': {
    ok: false,
    fieldErrors: {
      status: 'وضعیت تازه را از فهرست انتخاب کنید',
      reason: 'دلیل تغییر دست‌کم ۳ نویسه باشد',
    },
  },
  'report empty': {
    ok: false,
    fieldErrors: {
      assetId: 'این مقدار را وارد کنید',
      type: 'نوع کار را انتخاب کنید',
      title: 'این مقدار را وارد کنید',
      description: 'این مقدار را وارد کنید',
      severity: 'این مقدار را وارد کنید',
      outOfServiceAt: 'این مقدار را وارد کنید',
      dueDate: 'این مقدار را وارد کنید',
    },
  },
  'report type and severity outside their enums': {
    ok: false,
    fieldErrors: {
      assetId: 'شناسهٔ ماشین معتبر نیست',
      type: 'نوع کار را انتخاب کنید',
      title: 'این مقدار را وارد کنید',
      severity: 'شدت را از فهرست انتخاب کنید',
      outOfServiceAt: 'این مقدار را وارد کنید',
      dueDate: 'این مقدار را وارد کنید',
    },
  },
  'usage empty': {
    ok: false,
    fieldErrors: {
      assetId: 'این مقدار را وارد کنید',
      periodStart: 'این مقدار را وارد کنید',
      periodEnd: 'این مقدار را وارد کنید',
      hours: 'این مقدار را وارد کنید',
      kilometres: 'این مقدار را وارد کنید',
      hourMeter: 'این مقدار را وارد کنید',
      odometer: 'این مقدار را وارد کنید',
      notes: 'این مقدار را وارد کنید',
    },
  },
  'usage hours 0.5': {
    ok: false,
    fieldErrors: {
      assetId: 'این مقدار را وارد کنید',
      periodStart: 'این مقدار را وارد کنید',
      periodEnd: 'این مقدار را وارد کنید',
      kilometres: 'این مقدار را وارد کنید',
      hourMeter: 'این مقدار را وارد کنید',
      odometer: 'این مقدار را وارد کنید',
      notes: 'این مقدار را وارد کنید',
    },
  },
  'usage hours 1e999': {
    ok: false,
    fieldErrors: {
      assetId: 'این مقدار را وارد کنید',
      periodStart: 'این مقدار را وارد کنید',
      periodEnd: 'این مقدار را وارد کنید',
      hours: 'عددی نامنفی با حداکثر دو رقم اعشار وارد کنید',
      kilometres: 'این مقدار را وارد کنید',
      hourMeter: 'این مقدار را وارد کنید',
      odometer: 'این مقدار را وارد کنید',
      notes: 'این مقدار را وارد کنید',
    },
  },
  'order empty': {
    ok: false,
    fieldErrors: { offerId: 'این مقدار را وارد کنید', quantity: 'این مقدار را وارد کنید' },
  },
  'order quantity 0.5': {
    ok: false,
    fieldErrors: {
      offerId: 'این مقدار را وارد کنید',
      quantity: 'تعداد را به‌صورت عدد صحیح وارد کنید',
    },
  },
  'order quantity 1e999': {
    ok: false,
    fieldErrors: {
      offerId: 'این مقدار را وارد کنید',
      quantity: 'تعداد را به‌صورت عدد صحیح وارد کنید',
    },
  },
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(ZOD3[name]);
}

describe('a refused form names each field as it did under zod 3', () => {
  it.each([
    ['empty', {}],
    ['year 0.5', { name: 'Loader', type: 'EQUIPMENT', manufactureYear: '0.5' }],
    ['year 1e999', { name: 'Loader', type: 'EQUIPMENT', manufactureYear: '1e999' }],
    ['type outside its enum', { name: 'Loader', type: 'SPACESHIP' }],
  ])('register asset: %s', (name, values) => {
    matchesZod3(
      `register ${name}`,
      parseRegisterAssetForm({ ...EMPTY_REGISTER_ASSET_FORM, ...values }),
    );
  });

  it.each([
    ['empty', {}],
    ['status outside its enum', { status: 'GONE', reason: 'x' }],
  ])('change status: %s', (name, values) => {
    matchesZod3(
      `status ${name}`,
      parseChangeStatusForm({ ...EMPTY_CHANGE_STATUS_FORM, ...values }, 'ACTIVE' as never),
    );
  });

  it.each([
    ['empty', {}],
    [
      'type and severity outside their enums',
      { type: 'BOGUS', severity: 'X', assetId: 'AST_1', description: 'Broken' },
    ],
  ])('report maintenance: %s', (name, values) => {
    matchesZod3(`report ${name}`, parseReportRequestForm(values as never));
  });

  it.each([
    ['empty', {}],
    ['hours 0.5', { hours: '0.5' }],
    ['hours 1e999', { hours: '1e999' }],
  ])('usage: %s', (name, values) => {
    matchesZod3(`usage ${name}`, parseUsageForm(values as never, 'SUB-1'));
  });

  it.each([
    ['empty', {}],
    ['quantity 0.5', { quantity: '0.5' }],
    ['quantity 1e999', { quantity: '1e999' }],
  ])('place order: %s', (name, values) => {
    matchesZod3(`order ${name}`, parsePlaceOrderForm(values as never));
  });
});
