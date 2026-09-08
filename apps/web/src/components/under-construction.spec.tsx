import { render, screen } from '@testing-library/react';
import { UnderConstruction } from './under-construction';
import { CAPABILITIES, PREVIEW_DISCLOSURE } from '@/lib/capabilities';
import { expectNoAxeViolations } from '@/test/harness';

/**
 * The screens behind every capability this application does not operate.
 *
 * These pages are allowed to be rich — roadmap, architectural state, the
 * problem the capability would solve — and that richness is exactly why the
 * assertions below matter. A page that explains a feature well is one keystroke
 * away from looking like a page that *has* the feature.
 *
 * The `fetch` assertion is the load-bearing one. A placeholder that quietly
 * probed an endpoint would be doing, in the network tab, precisely what it tells
 * the reader it is not doing — and that is the discrepancy an investor demo
 * cannot survive being caught on.
 */

const NON_LIVE = CAPABILITIES.filter((capability) => capability.state !== 'LIVE');

/** A rendered amount, as opposed to the word "rial" appearing in prose. */
const MONEY_FIGURE = /[۰-۹][۰-۹٬]*\s*ریال/;

describe('capabilities this application does not operate', () => {
  it('has non-live capabilities to render', () => {
    expect(NON_LIVE.length).toBeGreaterThan(0);
  });

  it.each(NON_LIVE.map((capability) => [capability.key, capability] as const))(
    '%s never calls fetch',
    async (_key, capability) => {
      const fetchSpy = jest.fn();
      const original = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      try {
        render(<UnderConstruction capabilityKey={capability.key} />);
        // Anything asynchronous the component might have started has had a turn.
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = original;
      }
    },
  );

  it.each(NON_LIVE.map((capability) => [capability.key, capability] as const))(
    '%s carries the exact required disclosure',
    (_key, capability) => {
      render(<UnderConstruction capabilityKey={capability.key} />);

      // Verbatim, not paraphrased. A screenshot of this page travels further
      // than the room it was shown in.
      expect(screen.getByText(PREVIEW_DISCLOSURE)).toBeInTheDocument();
      expect(
        screen.getByText(/هیچ تراکنش واقعی انجام نمی‌شود و هیچ داده‌ای ثبت یا ارسال نمی‌گردد/),
      ).toBeInTheDocument();
      // The reason is stated, not collapsed into «به‌زودی».
      expect(screen.getByText(capability.evidence)).toBeInTheDocument();
    },
  );

  it.each(NON_LIVE.map((capability) => [capability.key] as const))(
    '%s shows no form, no chart, no rating and no money',
    (key) => {
      const { container } = render(<UnderConstruction capabilityKey={key} />);

      expect(container.querySelector('form')).toBeNull();
      expect(container.querySelector('input')).toBeNull();
      expect(container.querySelector('select')).toBeNull();
      expect(container.querySelector('textarea')).toBeNull();
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('canvas')).toBeNull();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(container.textContent).not.toMatch(MONEY_FIGURE);
    },
  );

  it('renders roadmap detail without turning it into a claim', () => {
    render(
      <UnderConstruction
        capabilityKey="procurement"
        value={['یک مسئلهٔ واقعی که هنوز حل نشده است.']}
        prerequisites={['یک تصمیم محصولی که هنوز گرفته نشده است.']}
      />,
    );

    expect(screen.getByText('یک مسئلهٔ واقعی که هنوز حل نشده است.')).toBeInTheDocument();
    expect(screen.getByText('یک تصمیم محصولی که هنوز گرفته نشده است.')).toBeInTheDocument();
    // Framed as a problem statement, never as a capability the platform has.
    expect(screen.getByText(/هیچ‌کدام از موارد زیر امروز کار نمی‌کند/)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <UnderConstruction capabilityKey="procurement" value={['نمونه']} prerequisites={['نمونه']} />,
    );
    await expectNoAxeViolations(container);
  });

  it('fails loudly on an unknown capability rather than rendering nothing', () => {
    // Rendering blank would look like a working-but-empty screen.
    expect(() => render(<UnderConstruction capabilityKey="not-a-capability" />)).toThrow(
      /Unknown capability key/,
    );
  });
});
