import { fireEvent, render } from '@testing-library/react';
import { axe } from 'jest-axe';
import { nonStandardSpelling } from '@/test/orthography';
import { RegisterAssetForm } from './assets/RegisterAssetForm';
import { NewDriverForm } from './drivers/NewDriverForm';
import { EMPTY_REGISTER_ASSET_FORM } from '@/lib/asset-form-fields';
import { EMPTY_CREATE_DRIVER_FORM } from '@/lib/driver-fields';
import type { RegisterAssetFormState } from './assets/form-state';
import type { CreateDriverFormState } from './drivers/form-state';

jest.mock('./assets/actions', () => ({
  submitRegisterAsset: jest.fn(),
  releaseUnresolvedAssetRegistration: jest.fn(),
}));
jest.mock('./drivers/actions', () => ({
  submitCreateDriver: jest.fn(),
  releaseUnresolvedDriverCreation: jest.fn(),
}));

const cases = [
  {
    name: 'asset',
    href: '/assets',
    field: 'name',
    values: {
      ...EMPTY_REGISTER_ASSET_FORM,
      ...EMPTY_CREATE_DRIVER_FORM,
      name: 'لودر',
      type: 'LOADER',
    },
    form: (state: RegisterAssetFormState, key = 'record') => (
      <RegisterAssetForm key={key} csrfToken="csrf" submissionId="fresh" initialState={state} />
    ),
  },
  {
    name: 'driver',
    href: '/drivers',
    field: 'userId',
    values: {
      ...EMPTY_CREATE_DRIVER_FORM,
      ...EMPTY_REGISTER_ASSET_FORM,
      userId: 'USR_1',
      notes: 'یادداشت',
    },
    form: (state: CreateDriverFormState, key = 'record') => (
      <NewDriverForm
        key={key}
        csrfToken="csrf"
        submissionId="fresh"
        initialState={state}
        picker={{ kind: 'PICK', candidates: [] }}
      />
    ),
  },
];

describe.each(cases)('FU-190 $name form hold', (c) => {
  it.each(['HELD', 'NOT_CHECKED', 'UNCONFIRMED'] as const)(
    'offers a separate accessible reconciliation form for %s',
    async (kind) => {
      const state: RegisterAssetFormState & CreateDriverFormState = {
        kind,
        submissionId: 'original',
        releaseToken: 'signed-record',
        correlationId: 'lost',
        values: c.values,
      };
      const { container, getByRole, getByLabelText } = render(c.form(state));
      const consent = getByLabelText(/می‌پذیرم/);
      expect(consent).toBeRequired();
      expect(consent).not.toBeChecked();
      fireEvent.click(consent);
      expect(consent).toBeChecked();
      expect(getByRole('link', { name: /فهرست کامل/ })).toHaveAttribute('href', c.href);
      expect(getByRole('button', { name: /رها کردن/ })).toBeEnabled();
      expect(container.querySelectorAll('form')).toHaveLength(2);
      expect(container.querySelector('form form')).toBeNull();
      expect(container.querySelector('[name="release"]')).toHaveValue('signed-record');
      expect(container.querySelector(`[name="${c.field}"]`)).toBeDisabled();
      if (kind !== 'NOT_CHECKED') {
        expect(container.querySelector('[name="submission"]')).toHaveValue('original');
        expect(container.querySelector(`[name="${c.field}"]`)).toHaveValue(
          c.values[c.field as keyof typeof c.values],
        );
      }
      expect(nonStandardSpelling(container.textContent ?? '')).toBeNull();
      expect(await axe(container)).toHaveNoViolations();
    },
  );
  it('keeps unavailable stores locked without a forged exit, and resets on a fresh page key', () => {
    const view = render(c.form({ kind: 'NOT_CHECKED' }));
    expect(view.container.querySelector('[name="release"]')).toBeNull();
    expect(view.container.querySelector(`[name="${c.field}"]`)).toBeDisabled();
    view.rerender(c.form({ kind: 'IDLE' }, 'fresh'));
    expect(view.container.querySelector(`[name="${c.field}"]`)).toBeEnabled();
    expect(view.container.querySelector('[name="submission"]')).toHaveValue('fresh');
  });
});
