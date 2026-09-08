import { render, screen } from '@testing-library/react';
import DashboardPage from '@/app/(portal)/page';
import { CapabilityCard } from './capability';
import { CAPABILITIES } from '@/lib/capabilities';
import { expectNoAxeViolations } from '@/test/harness';

/** A rendered amount: Persian digits, optional grouping, then the currency. */
const MONEY_FIGURE = /[۰-۹][۰-۹٬]*\s*ریال/;

/** A rendered percentage. */
const PERCENTAGE_FIGURE = /[۰-۹]\s*[٪%]/;

/**
 * The dashboard is the surface an investor looks at first, so it is the surface
 * most exposed to the temptation this whole milestone is written against:
 * putting a number on screen because a card looks empty without one.
 */

describe('dashboard', () => {
  it('fabricates no operational metric', () => {
    const { container } = render(<DashboardPage />);

    // Scoped to the two content sections. The page description above them says
    // which metrics are deliberately absent, and naming them there is the
    // opposite of fabricating them.
    const sections = [...container.querySelectorAll('section')]
      .map((section) => section.textContent ?? '')
      .join('\n');

    expect(sections).not.toBe('');
    // Nothing computes any of these — `analytics-service` is not built.
    expect(sections).not.toMatch(/حجم تراکنش|درآمد|نرخ بهره‌برداری|آپ‌تایم|میلیون|میلیارد/);
    // The two shapes a fabricated KPI takes: an amount and a percentage. Matched
    // as *figures* rather than as words, so prose that mentions rial pricing as a
    // thing that does not exist yet does not trip the assertion — that sentence
    // is the honesty, not a violation of it.
    expect(sections).not.toMatch(MONEY_FIGURE);
    expect(sections).not.toMatch(PERCENTAGE_FIGURE);
  });

  it('says out loud that it reports build status, not operations', () => {
    render(<DashboardPage />);
    expect(screen.getByText(/هیچ شاخص عملیاتی/)).toBeInTheDocument();
  });

  it('shows every capability with its state name', () => {
    const { container } = render(<DashboardPage />);

    for (const capability of CAPABILITIES) {
      expect(screen.getByRole('link', { name: capability.title })).toHaveAttribute(
        'href',
        capability.href,
      );
    }

    // The Latin state name travels with the Persian label, because the state
    // is what a reviewer greps for in this repository.
    expect(container.textContent).toContain('LIVE');
    expect(container.textContent).toContain('PLANNED');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<DashboardPage />);
    await expectNoAxeViolations(container);
  });
});

describe('capability card', () => {
  it('names the owning service, or says none exists', () => {
    const planned = CAPABILITIES.find((entry) => entry.service === null)!;
    render(<CapabilityCard capability={planned} />);

    expect(screen.getByText('سرویسی برای این دامنه وجود ندارد.')).toBeInTheDocument();
  });

  it('carries no figure of any kind', () => {
    for (const capability of CAPABILITIES) {
      const { container, unmount } = render(<CapabilityCard capability={capability} />);
      expect(container.textContent).not.toMatch(MONEY_FIGURE);
      expect(container.textContent).not.toMatch(PERCENTAGE_FIGURE);
      unmount();
    }
  });
});
