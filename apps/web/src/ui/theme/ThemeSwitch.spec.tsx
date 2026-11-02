import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { ThemeProvider, ThemeSwitch } from './ThemeSwitch';

/**
 * The switch writes in place: the attribute on `<html>` and one cookie. It
 * touches nothing else — no navigation, no storage, no remount.
 */

const html = document.documentElement;
const NAME = 'rasta_theme_0123456789abcdef01234567';

function cookiesOf(): string[] {
  return document.cookie ? document.cookie.split('; ') : [];
}

function clearCookies() {
  for (const pair of cookiesOf()) {
    document.cookie = `${pair.split('=')[0]}=; Max-Age=0; Path=/`;
  }
}

beforeEach(() => {
  html.setAttribute('data-theme', 'light');
  clearCookies();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const renderSwitch = () =>
  render(
    <ThemeProvider cookieName={NAME} secure={false}>
      <ThemeSwitch />
    </ThemeProvider>,
  );

const toggle = () => screen.getByRole('button', { name: 'حالت تیره' });

describe('the theme switch', () => {
  it('is a plain button that can never submit a form around it', () => {
    render(
      <form onSubmit={(event) => event.preventDefault()}>
        <ThemeProvider cookieName={NAME} secure={false}>
          <ThemeSwitch />
        </ThemeProvider>
      </form>,
    );
    expect(toggle()).toHaveAttribute('type', 'button');
  });

  it('says whether dark is on with aria-pressed, and keeps its label', async () => {
    renderSwitch();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    // Moved from outside (another switch, a script): seen on the next tick.
    await act(async () => html.setAttribute('data-theme', 'dark'));
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(toggle()).toHaveAccessibleName('حالت تیره');
  });

  it('starts pressed when the document already wears dark', () => {
    html.setAttribute('data-theme', 'dark');
    renderSwitch();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('changes the page and writes only its own cookie, in place', () => {
    renderSwitch();
    fireEvent.click(toggle());
    expect(html).toHaveAttribute('data-theme', 'dark');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(cookiesOf()).toEqual([`${NAME}=dark`]);

    fireEvent.click(toggle());
    expect(html).toHaveAttribute('data-theme', 'light');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(cookiesOf()).toEqual([`${NAME}=light`]);
  });

  // jsdom does not turn Enter / Space into a click; the real keyboard run is in
  // e2e/theme.spec.ts. What this pins is that the control is a native, focusable
  // button — the element the browser itself activates from the keyboard.
  it('is a native button in the tab order, so Enter and Space operate it', () => {
    renderSwitch();
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle()).not.toHaveAttribute('tabindex', '-1');
    toggle().focus();
    expect(toggle()).toHaveFocus();
  });

  it('does not remount, so a half-filled form keeps what was typed', () => {
    render(
      <ThemeProvider cookieName={NAME} secure={false}>
        <form>
          <input aria-label="مقدار" />
          <input type="hidden" name="submissionId" defaultValue="key-1" />
          <ThemeSwitch />
        </form>
      </ThemeProvider>,
    );
    const field = screen.getByLabelText('مقدار');
    fireEvent.change(field, { target: { value: '1250' } });
    fireEvent.click(toggle());
    expect(screen.getByLabelText('مقدار')).toBe(field);
    expect(field).toHaveValue('1250');
    expect(document.querySelector('input[name="submissionId"]')).toHaveValue('key-1');
  });

  it('touches no browser storage', () => {
    window.localStorage.setItem('keep', '1');
    window.sessionStorage.setItem('rasta-unresolved-order', '{"x":1}');
    renderSwitch();
    fireEvent.click(toggle());
    expect(Object.keys(window.localStorage)).toEqual(['keep']);
    expect(window.sessionStorage.getItem('rasta-unresolved-order')).toBe('{"x":1}');
  });

  it('still changes the page when the cookie cannot be written', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: () => {
        throw new Error('cookies are blocked');
      },
    });
    try {
      renderSwitch();
      fireEvent.click(toggle());
      expect(html).toHaveAttribute('data-theme', 'dark');
      expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    } finally {
      delete (document as { cookie?: string }).cookie;
      Object.defineProperty(Document.prototype, 'cookie', descriptor);
    }
  });

  it('writes the device cookie when nothing has told it whose page this is', () => {
    render(<ThemeSwitch />);
    fireEvent.click(toggle());
    expect(cookiesOf()).toEqual(['rasta_theme=dark']);
  });

  it('has no accessibility violations in either state', async () => {
    const { container } = renderSwitch();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(toggle());
    expect(await axe(container)).toHaveNoViolations();
  });
});
