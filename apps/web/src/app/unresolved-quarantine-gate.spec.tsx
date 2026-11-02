import { act, fireEvent, render, screen } from '@testing-library/react';

import { legacyKey } from '@/lib/unresolved-tenancy';
import type { Offer } from '@/server/marketplace';

import { PlaceOrderForm, type PlaceOrderFormProps } from './marketplace/[productId]/PlaceOrderForm';
import type { PlaceOrderFormState } from './marketplace/[productId]/place-order-form-state';
import {
  QUARANTINE_CONFIRM,
  QUARANTINE_CONTINUE,
  QUARANTINE_TEXT,
  QUARANTINE_TITLE,
} from './UnresolvedQuarantine';
import { OTHER_PERSON, bindingOf } from '@/test/unresolved-binding';

/**
 * The form's side of the device quarantine (PR 405 review 2, F1), with the real
 * order form and the real store: an earlier order this person cannot be shown
 * — written under an organization their token no longer lists — replaces the
 * form with a fixed warning; nothing of it is shown, nothing is sent, and only
 * the person's explicit acceptance of the duplicate risk brings the form back.
 */

const submit = jest.fn<Promise<PlaceOrderFormState>, [PlaceOrderFormState, FormData]>();
jest.mock('./marketplace/[productId]/place-order-actions', () => ({
  submitPlaceOrder: (previous: PlaceOrderFormState, form: FormData) => submit(previous, form),
}));

const OFFER: Offer = {
  id: 'OFR_1',
  productId: 'PRD_1',
  supplierOrganizationId: 'ORG-DEH-0002',
  unitPriceMinor: '300000',
  currency: 'IRR',
  availableQuantity: 15,
  leadTimeDays: 5,
  minimumQuantity: 2,
  supplierQualification: 'UNAVAILABLE',
};

/** This person now: their token lists none of the organizations the old record's tag could name. */
const NOW = bindingOf('owner-now', 'login-now', undefined, ['legacy-tag-now']);
const SOMEONE_ELSE = bindingOf('owner-9', 'login-9', OTHER_PERSON, ['legacy-tag-9']);

/** Written by an earlier build, for an organization nobody here can name. */
const OLD = JSON.stringify({
  v: 1,
  submissionId: 'sub_OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDO',
  values: { offerId: 'OFR_SECRET_OFFER', quantity: '77' },
  correlationId: 'COR_OLD',
  savedAt: Date.now(),
  owner: 'legacy-tag-of-a-membership-that-ended',
  session: 'login-then',
});
const OLD_KEY = legacyKey('rasta.unresolved-order.', 'PRD_OTHER');

function props(binding = NOW): PlaceOrderFormProps {
  return {
    offers: [OFFER],
    csrfToken: 'csrf',
    submissionId: 'sub_PAGEPAGEPAGEPAGEPAGEPAGEPAGEPAGEPAGEPAGEPA',
    newOrderHref: '/marketplace/PRD_1',
    productId: 'PRD_1',
    binding,
    sessionMaxAgeSeconds: 3600,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  submit.mockReset();
});

it('nothing held: the form is drawn as before', async () => {
  const { container } = render(<PlaceOrderForm {...props()} />);
  await act(async () => undefined);
  expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
  expect(container.querySelector('[name="quantity"]')).not.toBeNull();
});

it('an earlier order of unknown outcome: fixed warning, no form, nothing of it shown, nothing sent', async () => {
  window.sessionStorage.setItem(OLD_KEY, OLD);
  const { container } = render(<PlaceOrderForm {...props()} />);
  await act(async () => undefined);

  expect(screen.getByText(QUARANTINE_TITLE)).not.toBeNull();
  expect(screen.getByText(QUARANTINE_TEXT)).not.toBeNull();
  expect(container.querySelector('[name="quantity"]')).toBeNull();
  expect(container.textContent).not.toContain('OFR_SECRET_OFFER');
  expect(container.textContent).not.toContain('77');
  expect(submit).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(OLD_KEY)).toBe(OLD);
});

it('continues only after the explicit acceptance; then the form is back and the record is untouched', async () => {
  window.sessionStorage.setItem(OLD_KEY, OLD);
  const { container } = render(<PlaceOrderForm {...props()} />);
  await act(async () => undefined);

  const proceed = screen.getByRole('button', { name: QUARANTINE_CONTINUE });
  expect((proceed as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(proceed);
  expect(container.querySelector('[name="quantity"]')).toBeNull();

  fireEvent.click(screen.getByLabelText(QUARANTINE_CONFIRM));
  expect((proceed as HTMLButtonElement).disabled).toBe(false);
  await act(async () => {
    fireEvent.click(proceed);
  });

  expect(screen.queryByText(QUARANTINE_TITLE)).toBeNull();
  expect(container.querySelector('[name="quantity"]')).not.toBeNull();
  expect(submit).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(OLD_KEY)).toBe(OLD);
});

it('one person’s acceptance is theirs: another person on the device is still warned', async () => {
  window.sessionStorage.setItem(OLD_KEY, OLD);
  const first = render(<PlaceOrderForm {...props()} />);
  await act(async () => undefined);
  fireEvent.click(screen.getByLabelText(QUARANTINE_CONFIRM));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: QUARANTINE_CONTINUE }));
  });
  first.unmount();

  render(<PlaceOrderForm {...props(SOMEONE_ELSE)} />);
  await act(async () => undefined);
  expect(screen.getByText(QUARANTINE_TITLE)).not.toBeNull();
});
