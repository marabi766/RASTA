import { axe } from 'jest-axe';
import { act, fireEvent, screen } from '@testing-library/react';

import { renderInDirection } from '@/test/directions';

import { Field } from './Field';
import { JalaliDateInput } from './JalaliDateInput';

function form(type: 'date' | 'datetime-local', defaultValue = '') {
  return (
    <form aria-label="فرم">
      <Field label="تاریخ" hint="راهنما">
        {(control) => (
          <JalaliDateInput {...control} type={type} name="when" defaultValue={defaultValue} />
        )}
      </Field>
    </form>
  );
}

describe('JalaliDateInput', () => {
  it('keeps the native control, its name and its value', () => {
    renderInDirection(form('date', '2026-09-18'), 'rtl');
    const input = screen.getByLabelText('تاریخ') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'date');
    expect(input).toHaveAttribute('name', 'when');
    expect(input.value).toBe('2026-09-18');
  });

  it('names the format in Persian and shows the chosen day in Jalali', () => {
    renderInDirection(form('date'), 'rtl');
    expect(screen.getByText(/تاریخ را میلادی و به قالب مرورگر وارد کنید/)).toBeInTheDocument();
    expect(screen.getByTestId('jalali-echo')).toHaveTextContent('تاریخی انتخاب نشده است');

    fireEvent.change(screen.getByLabelText('تاریخ'), { target: { value: '2026-09-18' } });
    expect(screen.getByTestId('jalali-echo')).toHaveTextContent('معادل شمسی: ۲۷ شهریور ۱۴۰۵');
  });

  it('starts from the form’s own default (a refused form comes back with its value)', () => {
    renderInDirection(form('date', '2026-03-21'), 'rtl');
    expect(screen.getByTestId('jalali-echo')).toHaveTextContent('۱ فروردین ۱۴۰۵');
  });

  it('reads a date-time in Tehran time', () => {
    renderInDirection(form('datetime-local'), 'rtl');
    expect(screen.getByText(/ساعت را به وقت تهران/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('تاریخ'), { target: { value: '2026-09-19T01:00' } });
    expect(screen.getByTestId('jalali-echo')).toHaveTextContent('۱۴۰۵/۰۶/۲۸ ۰۱:۰۰');
  });

  it('shows nothing for an emptied value and follows a form reset', async () => {
    renderInDirection(form('date', '2026-09-18'), 'rtl');
    const input = screen.getByLabelText('تاریخ');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('jalali-echo')).toHaveTextContent('تاریخی انتخاب نشده است');

    fireEvent.change(input, { target: { value: '2026-12-31' } });
    await act(async () => {
      (screen.getByRole('form', { name: 'فرم' }) as HTMLFormElement).reset();
      await new Promise((done) => setTimeout(done, 5));
    });
    expect(screen.getByTestId('jalali-echo')).toHaveTextContent('۲۷ شهریور ۱۴۰۵');
  });

  it('ties the format line and the echo to the control for a screen reader', () => {
    renderInDirection(form('date'), 'rtl');
    const input = screen.getByLabelText('تاریخ');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ');
    // The field's own hint, the format line, the echo.
    expect(described).toHaveLength(3);
    for (const id of described) expect(document.getElementById(id)).not.toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(form('date', '2026-09-18'), 'rtl');
    expect(await axe(container)).toHaveNoViolations();
  });
});
