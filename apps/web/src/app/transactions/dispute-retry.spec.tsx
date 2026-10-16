import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { EMPTY_DISPUTE_FORM } from '@/lib/transaction-dispute-fields';

import { DisputeCommandForm } from './[id]/DisputeCommandForm';
import type { DisputeFormState } from './[id]/form-state';

/**
 * The unconfirmed path with the real `useActionState`: only the action's own
 * body is scripted. Proves the retry posts the same key and the same text, and
 * that a call which itself fails (a lost response, or the portal's gate
 * answering an ended session) never turns into "nothing changed".
 */

const submit = jest.fn<Promise<DisputeFormState>, [string, DisputeFormState, FormData]>();
jest.mock('./[id]/actions', () => ({
  submitDisputeCommand: (id: string, previous: DisputeFormState, form: FormData) =>
    submit(id, previous, form),
}));

const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const REASON = 'کالا تحویل نشده و پاسخی هم نیامده است';

function renderForm() {
  return render(
    <DisputeCommandForm
      transactionId="TXN_1"
      command="DISPUTE"
      csrfToken="csrf"
      submissionId={KEY}
    />,
  );
}

async function submitForm(container: HTMLElement) {
  await act(async () => {
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
  });
}

beforeEach(() => submit.mockReset());

it('re-sends the first request’s key and text, and keeps its tracking code', async () => {
  submit.mockResolvedValueOnce({
    kind: 'UNCONFIRMED',
    command: 'DISPUTE',
    correlationId: 'COR_ORIGINAL',
    submissionId: KEY,
    values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
  });
  const { container } = renderForm();
  fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
  await submitForm(container);
  await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

  submit.mockImplementationOnce(async (_id, previous) => ({
    ...(previous as Extract<DisputeFormState, { kind: 'UNCONFIRMED' }>),
    retryUnknown: true,
  }));
  await submitForm(container);

  const [id, previous, form] = submit.mock.calls[1]!;
  expect(id).toBe('TXN_1');
  expect(previous.kind).toBe('UNCONFIRMED');
  expect(form.get('submission')).toBe(KEY);
  expect(form.get('reason')).toBe(REASON);
  expect(form.get('command')).toBe('DISPUTE');
  await waitFor(() => expect(screen.getByText(/نتیجهٔ روشنی نداشت/)).toBeInTheDocument());
  expect(container.textContent).toContain('COR_ORIGINAL');
});

it('a first send whose call fails is unconfirmed — same key, the text as it would be sent', async () => {
  submit.mockRejectedValueOnce(new Error('An unexpected response was received from the server.'));
  const { container } = renderForm();
  fireEvent.change(container.querySelector('[name="reason"]')!, {
    target: { value: `  ${REASON}  ` },
  });
  await submitForm(container);

  await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());
  expect(container.textContent).not.toContain('کد پیگیری');
  expect(container.querySelector('[name="submission"]')).toHaveValue(KEY);
  expect(container.querySelector('[name="reason"]')).toHaveValue(REASON);
  expect(screen.getByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeEnabled();
});

it('a retry whose call fails keeps the doubt and withdraws the retry — the session ended', async () => {
  submit.mockResolvedValueOnce({
    kind: 'UNCONFIRMED',
    command: 'DISPUTE',
    correlationId: 'COR_ORIGINAL',
    submissionId: KEY,
    values: { ...EMPTY_DISPUTE_FORM, reason: REASON },
  });
  const { container } = renderForm();
  fireEvent.change(container.querySelector('[name="reason"]')!, { target: { value: REASON } });
  await submitForm(container);
  await waitFor(() => expect(screen.getByText(/نتوانستیم تأیید کنیم/)).toBeInTheDocument());

  submit.mockRejectedValueOnce(new Error('An unexpected response was received from the server.'));
  await submitForm(container);

  await waitFor(() => expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument());
  expect(container.textContent).toContain('COR_ORIGINAL');
  expect(screen.queryByRole('button', { name: 'ارسال دوبارهٔ همین درخواست' })).toBeNull();
});
