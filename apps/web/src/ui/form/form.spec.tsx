import { amountMinorSchema } from '@rasta/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { z } from 'zod';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { Form, useSchemaForm } from './Form';
import { MoneyField } from './MoneyField';
import { TextField } from './TextField';

/**
 * The schema is assembled from `@rasta/contracts`, not written here.
 *
 * `amountMinorSchema` is the same object the services validate an amount
 * against. docs/16 § 16.1 makes that a constraint rather than a convention:
 * one definition for the form, the server, the TypeScript type and the OpenAPI
 * document. If the platform tightens what an amount may be, this form tightens
 * with it and no one has to remember to come here.
 */
const requestSchema = z.object({
  title: z.string().min(3, 'عنوان دست‌کم سه نویسه است'),
  amountMinor: amountMinorSchema,
});

type RequestValues = z.input<typeof requestSchema>;

function RequestForm({ onSubmit = () => {} }: { onSubmit?: (values: RequestValues) => void }) {
  const form = useSchemaForm(requestSchema, { defaultValues: { title: '', amountMinor: '' } });
  return (
    <Form
      form={form}
      onSubmit={onSubmit}
      actions={
        <button type="submit" data-testid="submit">
          ثبت
        </button>
      }
    >
      <TextField form={form} name="title" label="عنوان" required hint="نام درخواست" />
      <MoneyField form={form} name="amountMinor" label="مبلغ" required />
    </Form>
  );
}

describe('Field wiring', () => {
  // Four ids have to agree for a label, a hint and an error to reach the
  // control. It is the kind of thing a person gets wrong once per form.
  it('associates the label, the hint and the control', () => {
    renderInDirection(<RequestForm />, 'rtl');
    const input = screen.getByLabelText(/عنوان/);
    expect(input).toBeInTheDocument();
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('نام درخواست');
  });

  it('marks a required field for assistive technology, not only with an asterisk', () => {
    renderInDirection(<RequestForm />, 'rtl');
    expect(screen.getByLabelText(/عنوان/)).toHaveAttribute('aria-required', 'true');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(<RequestForm />, 'rtl');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('TextField', () => {
  // A name typed on an Arabic keyboard never matches one typed on a Persian
  // keyboard. Normalising on blur — not per keystroke — fixes it without
  // rewriting characters under the cursor.
  it('normalises Arabic letter forms when the field is left', async () => {
    renderInDirection(<RequestForm />, 'rtl');
    const input = screen.getByLabelText(/عنوان/) as HTMLInputElement;
    const arabicKaf = String.fromCodePoint(0x0643);
    const keheh = String.fromCodePoint(0x06a9);

    fireEvent.change(input, { target: { value: `${arabicKaf}تاب` } });
    fireEvent.blur(input);

    await waitFor(() => expect(input.value).toBe(`${keheh}تاب`));
  });

  it('reports the schema message when the value is too short', async () => {
    renderInDirection(<RequestForm />, 'rtl');
    const input = screen.getByLabelText(/عنوان/);
    fireEvent.change(input, { target: { value: 'ab' } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText('عنوان دست‌کم سه نویسه است')).toBeInTheDocument());
  });
});

describe('MoneyField', () => {
  // docs/16 § 16.5: typed in any digits, stored as minor units, shown grouped
  // with Persian digits.
  it('turns Persian digits into a minor-unit string and shows them grouped', async () => {
    const onSubmit = jest.fn();
    renderInDirection(<RequestForm onSubmit={onSubmit} />, 'rtl');

    const title = screen.getByLabelText(/عنوان/);
    fireEvent.change(title, { target: { value: 'اجارهٔ بیل مکانیکی' } });

    const amount = screen.getByLabelText(/مبلغ/) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '۱۰۰۰۰۰۰۰' } });
    fireEvent.blur(amount);

    await waitFor(() => expect(amount.value).toBe('۱۰٬۰۰۰٬۰۰۰'));

    fireEvent.click(screen.getByTestId('submit'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: '10000000' }),
        expect.anything(),
      ),
    );
  });

  it('accepts a grouped Latin amount just as readily', async () => {
    const onSubmit = jest.fn();
    renderInDirection(<RequestForm onSubmit={onSubmit} />, 'rtl');
    fireEvent.change(screen.getByLabelText(/عنوان/), { target: { value: 'خرید قطعه' } });

    const amount = screen.getByLabelText(/مبلغ/) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '1,250,000' } });
    fireEvent.blur(amount);
    fireEvent.click(screen.getByTestId('submit'));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: '1250000' }),
        expect.anything(),
      ),
    );
  });

  // Clearing what someone typed because it did not parse is the fastest way
  // to make them retype a long number they had almost right.
  it('keeps the typed text on screen when it cannot be read as an amount', async () => {
    renderInDirection(<RequestForm />, 'rtl');
    const amount = screen.getByLabelText(/مبلغ/) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: 'صد هزار' } });
    fireEvent.blur(amount);

    await waitFor(() => expect(screen.getByText(/نمی‌توان/)).toBeInTheDocument());
    expect(amount.value).toBe('صد هزار');
  });

  // The rial is quoted whole, so a decimal is a typo rather than a value.
  it('refuses a decimal for a currency that has none', async () => {
    renderInDirection(<RequestForm />, 'rtl');
    const amount = screen.getByLabelText(/مبلغ/);
    fireEvent.change(amount, { target: { value: '1.5' } });
    fireEvent.blur(amount);

    await waitFor(() => expect(screen.getByText(/جزء اعشاری ندارد/)).toBeInTheDocument());
  });

  // The reason money never becomes a number anywhere in this stack.
  it('keeps every digit of an amount past the safe integer range', async () => {
    const onSubmit = jest.fn();
    renderInDirection(<RequestForm onSubmit={onSubmit} />, 'rtl');
    fireEvent.change(screen.getByLabelText(/عنوان/), { target: { value: 'قرارداد بزرگ' } });

    const amount = screen.getByLabelText(/مبلغ/);
    fireEvent.change(amount, { target: { value: '9007199254740993000' } });
    fireEvent.blur(amount);
    fireEvent.click(screen.getByTestId('submit'));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ amountMinor: '9007199254740993000' }),
        expect.anything(),
      ),
    );
  });

  itSnapshotsInBothDirections('an empty request form', () => <RequestForm />);
});
