import { act, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

import { ThemeOwner, ThemeSwitch } from './ThemeSwitch';

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
    <>
      <ThemeOwner cookieName={NAME} secure={false} />
      <ThemeSwitch />
    </>,
  );

const toggle = () => screen.getByRole('button', { name: 'حالت تیره' });

describe('the theme switch', () => {
  it('is a plain button that can never submit a form around it', () => {
    render(
      <form onSubmit={(event) => event.preventDefault()}>
        <ThemeOwner cookieName={NAME} secure={false} />
        <ThemeSwitch />
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
    // As the server rendered it: the attribute and the person's cookie agree.
    html.setAttribute('data-theme', 'dark');
    document.cookie = `${NAME}=dark; Path=/`;
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
      <>
        <ThemeOwner cookieName={NAME} secure={false} />
        <form>
          <input aria-label="مقدار" />
          <input type="hidden" name="submissionId" defaultValue="key-1" />
          <ThemeSwitch />
        </form>
      </>,
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

  it('is not drawn when its page named no owner: it never writes under a default name', () => {
    render(<ThemeSwitch />);
    expect(screen.queryByRole('button', { name: 'حالت تیره' })).toBeNull();
    expect(cookiesOf()).toEqual([]);
  });

  it('has no accessibility violations in either state', async () => {
    const { container } = renderSwitch();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(toggle());
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * Whose preference a retained document keeps (PR 595 review, F1). The root
 * layout survives a soft navigation, so the page renders the owner itself:
 * these tests swap the page under a document that stays — which is exactly
 * what a Next `<Link>` does — and never rebuild it.
 */
describe('the owner a page declares', () => {
  const A = 'rasta_theme_aaaaaaaaaaaaaaaaaaaaaaaa';
  const B = 'rasta_theme_bbbbbbbbbbbbbbbbbbbbbbbb';
  const page = (owner: string | null) => (
    <>
      {owner ? <ThemeOwner cookieName={owner} secure={false} /> : null}
      <ThemeSwitch />
    </>
  );

  // Each test starts the document as a fresh load: no owner has ever applied.
  async function freshDocument() {
    const first = render(page('rasta_theme_cccccccccccccccccccccccc'));
    first.unmount();
    clearCookies();
    html.setAttribute('data-theme', 'light');
  }
  beforeEach(freshDocument);

  it("takes another account's theme from its own cookie, not from the old one's", () => {
    document.cookie = `${A}=dark; Path=/`;
    const view = render(page(A));
    expect(html).toHaveAttribute('data-theme', 'dark');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');

    // The same document, the page beneath it replaced by B's, who has no cookie.
    view.rerender(page(B));
    expect(html).toHaveAttribute('data-theme', 'light');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('corrects an attribute changed by hand, which an equal root prop would leave', () => {
    // The root layout renders data-theme="light" for A and for B alike: React
    // sees no change and writes nothing. Only the owner can repair it.
    const view = render(page(A));
    fireEvent.click(toggle());
    expect(html).toHaveAttribute('data-theme', 'dark');
    view.rerender(page(B));
    expect(html).toHaveAttribute('data-theme', 'light');
  });

  it("writes the new owner's cookie after the switch, and leaves the old one's alone", () => {
    const view = render(page(A));
    fireEvent.click(toggle());
    expect(cookiesOf()).toEqual([`${A}=dark`]);

    view.rerender(page(B));
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(cookiesOf().sort()).toEqual([`${A}=dark`, `${B}=dark`]);
    expect(html).toHaveAttribute('data-theme', 'dark');
  });

  it('keeps the attribute for the same owner on the next page (cookies blocked)', () => {
    const view = render(page(A));
    fireEvent.click(toggle());
    clearCookies();
    // The next page of the same person: a new owner element, same name.
    view.unmount();
    render(page(A));
    expect(html).toHaveAttribute('data-theme', 'dark');
  });

  it('draws no switch once the page that named the owner is gone', () => {
    const view = render(page(A));
    expect(toggle()).toBeInTheDocument();
    view.rerender(page(null));
    expect(screen.queryByRole('button', { name: 'حالت تیره' })).toBeNull();
  });

  it('reads only its own cookie: a strictly parsed value, nothing else', () => {
    document.cookie = `${A}=dark; Path=/`;
    document.cookie = `${B}=DARK; Path=/`;
    render(page(B));
    expect(html).toHaveAttribute('data-theme', 'light');
  });

  it('is no owner at all for a name the theme may never use', () => {
    for (const bad of ['session', 'rasta_theme_x', 'rasta_theme; Path=/', '']) {
      const view = render(page(bad));
      expect(screen.queryByRole('button', { name: 'حالت تیره' })).toBeNull();
      view.unmount();
    }
    expect(cookiesOf()).toEqual([]);
  });
});
