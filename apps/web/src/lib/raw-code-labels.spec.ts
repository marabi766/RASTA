import { STATUS_TONES } from '@/ui';
import { StatusBadge } from '@/ui/feedback/StatusBadge';
import { render } from '@testing-library/react';
import { createElement } from 'react';

import {
  standingVerdictLabel,
  timelineTitleLabel,
  transactionReasonLabel,
  transactionSourceLabel,
} from './labels';
import { ROLE_LABELS, roleLabel, userStatusLabel } from './organization-fields';

/**
 * The class «a backend code is drawn as its raw spelling in the Persian UI»:
 * every label function names what it knows and falls back to the code only for
 * a value it has never heard of; the status badge never draws a status it
 * tabulates without a Persian word.
 */

const LATIN_CODE = /[A-Z_]{3,}/;

describe('status badge', () => {
  it.each(Object.keys(STATUS_TONES))('has a Persian default label for %s', (status) => {
    const { container } = render(createElement(StatusBadge, { status }));
    expect(container.textContent).not.toMatch(LATIN_CODE);
    expect(container.textContent).not.toBe('');
  });

  it('draws a status nobody has heard of as sent', () => {
    const { container } = render(createElement(StatusBadge, { status: 'SOMETHING_NEW' }));
    expect(container.textContent).toBe('SOMETHING_NEW');
  });
});

describe('label functions', () => {
  it('names every role the portal knows, and shows an unknown one as sent', () => {
    for (const role of Object.keys(ROLE_LABELS)) expect(roleLabel(role)).not.toMatch(LATIN_CODE);
    expect(roleLabel('BRAND_NEW_ROLE')).toBe('BRAND_NEW_ROLE');
  });

  it.each(['PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'])('names user status %s', (status) => {
    expect(userStatusLabel(status)).not.toMatch(LATIN_CODE);
  });

  it.each(['ORDER', 'MAINTENANCE_REQUEST', 'PAYMENT_INTENT', 'STATEMENT'])(
    'names transaction source %s',
    (type) => expect(transactionSourceLabel(type)).not.toMatch(LATIN_CODE),
  );
  it.each(['ELIGIBLE', 'NOT_ELIGIBLE'])('names standing verdict %s', (verdict) => {
    expect(standingVerdictLabel(verdict)).not.toMatch(LATIN_CODE);
  });
  it('shows a source type or verdict it does not know as sent', () => {
    expect(transactionSourceLabel('NEW_SOURCE')).toBe('NEW_SOURCE');
    expect(standingVerdictLabel('PROBATION')).toBe('PROBATION');
  });
});

describe('timelineTitleLabel', () => {
  it('replaces an asset-status code inside a Persian title', () => {
    expect(timelineTitleLabel('تغییر وضعیت به DECOMMISSIONED')).toBe('تغییر وضعیت به از رده خارج');
    expect(timelineTitleLabel('تغییر وضعیت به OUT_OF_SERVICE')).not.toMatch(LATIN_CODE);
  });
  it('leaves other text, and codes that are not asset statuses, alone', () => {
    expect(timelineTitleLabel('سرویس دوره‌ای تکمیل شد')).toBe('سرویس دوره‌ای تکمیل شد');
    expect(timelineTitleLabel('رویداد ABC_EVENT')).toBe('رویداد ABC_EVENT');
  });
});

describe('transactionReasonLabel', () => {
  it('maps each known machine reason to its Persian label', () => {
    // The closed set, one row per reason, with the line that writes it:
    // marketplace-service/src/temporal/workflows.ts:567.
    expect(
      Object.fromEntries(
        ['Cancelled'].map((machineReason) => [
          machineReason,
          transactionReasonLabel(machineReason),
        ]),
      ),
    ).toEqual({ Cancelled: 'لغو شد' });
  });

  it.each([
    'Customer returned damaged goods',
    'مشتری منصرف شد',
    'wallet empty',
    'REFUND_REQUESTED',
    'cancelled',
    ' Cancelled',
    'Cancelled.',
    'کالا Komatsu برگشت',
    '۱۲۳ - ۴۵',
    'constructor',
    'toString',
    '__proto__',
  ])('shows %s as written: anything outside the closed set is a person’s', (reason) => {
    expect(transactionReasonLabel(reason)).toBe(reason);
  });
});
