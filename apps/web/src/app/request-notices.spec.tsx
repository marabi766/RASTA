import { render } from '@testing-library/react';
import { REQUEST_NOT_CHECKED } from '@/lib/request-not-checked';
import { nonStandardSpelling } from '@/test/orthography';
import { RegisterAssetForm } from './assets/RegisterAssetForm';
import { NewDriverForm } from './drivers/NewDriverForm';
import { TopUpForm } from './wallet/TopUpForm';

jest.mock('./assets/actions', () => ({
  submitRegisterAsset: jest.fn(),
  releaseUnresolvedAssetRegistration: jest.fn(),
}));
jest.mock('./drivers/actions', () => ({
  submitCreateDriver: jest.fn(),
  releaseUnresolvedDriverCreation: jest.fn(),
}));
jest.mock('./wallet/actions', () => ({
  submitTopUp: jest.fn(),
  releaseUnresolvedTopUp: jest.fn(),
}));

describe.each(['asset', 'driver', 'wallet'])('FU-210 %s notices', (form) => {
  it.each(Object.keys(REQUEST_NOT_CHECKED) as (keyof typeof REQUEST_NOT_CHECKED)[])(
    '%s stays locked with distinct wording',
    (reason) => {
      const props = {
        csrfToken: 'csrf',
        submissionId: '',
        initialState: { kind: 'NOT_CHECKED' as const, reason },
      };
      const view = render(
        form === 'asset' ? (
          <RegisterAssetForm {...props} />
        ) : form === 'driver' ? (
          <NewDriverForm {...props} picker={{ kind: 'PICK', candidates: [] }} />
        ) : (
          <TopUpForm {...props} walletId="WLT_1" />
        ),
      );
      expect(view.getByText(REQUEST_NOT_CHECKED[reason])).toBeInTheDocument();
      expect(view.container.querySelector('button[type="submit"]')).toBeDisabled();
      expect(nonStandardSpelling(view.container.textContent ?? '')).toBeNull();
    },
  );
});
