import { act, fireEvent, waitFor } from '@testing-library/react';

import { SUBMISSION_FIELD } from '@/lib/form-fields';

/**
 * The submission id a refused attempt hands back. It differs from the one every
 * form is rendered with, so a test can tell the refusal has been applied.
 */
export const REFUSED_SUBMISSION = 'sub_REFUSEDREFUSEDREFUSED';

/**
 * A server action that refuses whatever it is sent, the way every portal action
 * answers a rejected attempt: `INVALID`, carrying the person's own values back so
 * the form is not emptied under them. Bound arguments (the asset, the driver)
 * come first and the `FormData` last, so one function stands in for all of them.
 */
export async function refuse(...args: unknown[]): Promise<unknown> {
  const data = args[args.length - 1] as FormData;
  const values: Record<string, string> = {};
  for (const [name, value] of data.entries()) {
    if (typeof value === 'string') values[name] = value;
  }
  return {
    kind: 'INVALID',
    submissionId: REFUSED_SUBMISSION,
    values,
    fieldErrors: {},
    message: 'refused',
  };
}

/**
 * The real sequence behind "the form forgot my choice": the person picks an
 * option, submits, the action refuses, React applies the returned state and then
 * resets the form. Nothing here is stubbed but the action itself — the point of
 * the spec is the real `useActionState` and the real form reset, which a spec
 * that mounts a form with its state already set (or stubs `useActionState`)
 * never reaches.
 *
 * Returns the value the select showed before submit and the one it shows after.
 */
export async function pickSubmitAndRead(
  container: HTMLElement,
  selectName: string,
): Promise<{ picked: string; shownAfter: string }> {
  const select = () => container.querySelector(`select[name="${selectName}"]`) as HTMLSelectElement;
  const initial = select().value;
  // The last option the select is not already showing, so the pick is neither
  // the blank entry nor the first choice a select falls back to when its
  // selection is lost.
  const options = [...select().options].filter(
    (option) => !option.disabled && option.value !== '' && option.value !== initial,
  );
  const picked = options[options.length - 1]!.value;

  fireEvent.change(select(), { target: { value: picked } });
  expect(select().value).toBe(picked);

  await act(async () => {
    fireEvent.submit(select().form!);
  });
  await waitFor(() =>
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(
      REFUSED_SUBMISSION,
    ),
  );
  // The reset follows the action's state update; let it land.
  await act(async () => undefined);

  return { picked, shownAfter: select().value };
}
