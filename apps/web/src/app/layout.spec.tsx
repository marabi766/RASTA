import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { LoginScreen } from './login/LoginScreen';
import RootLayout, { metadata } from './layout';

/**
 * `RootLayout` renders `<html>` and `<body>`, which React cannot mount inside
 * an existing document. Asserting the two attributes therefore means reading
 * them off the element the component returns rather than off a rendered tree.
 */
function rootElement() {
  const tree = RootLayout({ children: null }) as {
    props: { lang?: string; dir?: string };
  };
  return tree.props;
}

describe('the document shell', () => {
  // docs/16 § 16.3: the direction is a property of the document. Every layout
  // rule beneath it is written with logical properties on that assumption, so
  // losing either attribute silently mirrors the whole application.
  it('declares Persian and right-to-left on the document itself', () => {
    expect(rootElement().lang).toBe('fa');
    expect(rootElement().dir).toBe('rtl');
  });

  it('names the product in the document title', () => {
    expect(metadata.title).toBe('رستا');
  });
});

/**
 * The page under test is `/login` rather than `/`.
 *
 * `/` became a real screen in EXP-002: it reads the session and, without one,
 * redirects. Rendering it here would test the redirect. `/login` is the page
 * an unauthenticated visitor actually sees, it needs no session, and it is the
 * first thing every user of this product meets — which makes it the right
 * place for the accessibility assertion to live.
 */
describe('the way in', () => {
  const renderLogin = (reason?: string) => render(<LoginScreen reason={reason} />);

  it('renders one top-level heading', () => {
    const { getByRole } = renderLogin();
    expect(getByRole('heading', { level: 1 })).toHaveTextContent('ورود به رستا');
  });

  it('offers a way in that needs no javascript', () => {
    // A link, not a scripted button: the page works on a slow connection with
    // scripts blocked, and a content security policy can forbid inline script
    // without breaking the entrance.
    const { getByRole } = renderLogin();
    expect(getByRole('link', { name: /ورود با حساب سازمانی/ })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });

  it('says plainly that no password is typed here', () => {
    const { getByText } = renderLogin();
    expect(getByText(/گذرواژهٔ شما هرگز به این پورتال وارد نمی‌شود/)).toBeInTheDocument();
  });

  it('explains a refusal it recognises', () => {
    expect(
      renderLogin('state_mismatch').getByText(/دوباره از همین صفحه شروع کنید/),
    ).toBeInTheDocument();
  });

  it('says nothing at all about a code it does not recognise', () => {
    // Whatever arrives in a query string is somebody else's text until this
    // map has agreed to it. An unknown code renders no banner rather than
    // being echoed back onto the page.
    expect(renderLogin('<script>alert(1)</script>').queryByRole('alert')).toBeNull();
  });

  // docs/16 § 16.9 commits this product to WCAG 2.1 AA. The assertion is here
  // from the first page so that accessibility is a property the suite already
  // checks, rather than an audit someone schedules later.
  it('has no accessibility violations', async () => {
    const { container } = renderLogin();
    expect(await axe(container)).toHaveNoViolations();
  });
});
