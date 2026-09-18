import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import HomePage from './page';
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

describe('the entry route', () => {
  it('renders one top-level heading', () => {
    const { getByRole } = render(<HomePage />);
    expect(getByRole('heading', { level: 1 })).toHaveTextContent('رستا');
  });

  // docs/16 § 16.9 commits this product to WCAG 2.1 AA. The assertion is here
  // from the first page so that accessibility is a property the suite already
  // checks, rather than an audit someone schedules later.
  it('has no accessibility violations', async () => {
    const { container } = render(<HomePage />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
