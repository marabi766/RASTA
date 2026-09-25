import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { LoginScreen } from './LoginScreen';

/**
 * The signed-out landing page — a plain function of its props, so this file
 * renders it directly the way `LoginScreen.tsx`'s own docstring describes.
 */

describe('the way in, and where it goes afterwards (L5-07)', () => {
  it('links straight to /auth/login when there is nowhere in particular to return to', () => {
    const { getByRole } = render(<LoginScreen />);
    expect(getByRole('link', { name: /ورود با حساب سازمانی/ })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });

  it('carries a real destination through as a query parameter', () => {
    const { getByRole } = render(<LoginScreen returnTo="/usage" />);
    expect(getByRole('link', { name: /ورود با حساب سازمانی/ })).toHaveAttribute(
      'href',
      '/auth/login?returnTo=%2Fusage',
    );
  });

  it('treats the root path the same as no destination at all', () => {
    const { getByRole } = render(<LoginScreen returnTo="/" />);
    expect(getByRole('link', { name: /ورود با حساب سازمانی/ })).toHaveAttribute(
      'href',
      '/auth/login',
    );
  });
});

describe('a refusal reason', () => {
  it('shows the sentence for a code this portal knows', () => {
    const { getByText } = render(<LoginScreen reason="provider_refused" />);
    expect(getByText(/ورود در سامانهٔ احراز هویت کامل نشد/)).toBeInTheDocument();
  });

  it('shows nothing for a code it does not — whatever arrives in a query string is not trusted text', () => {
    const { queryByRole } = render(<LoginScreen reason="<script>alert(1)</script>" />);
    expect(queryByRole('alert')).toBeNull();
  });
});

describe('accessibility', () => {
  it('has no violations', async () => {
    const { container } = render(<LoginScreen returnTo="/usage" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
