import { render, screen } from '@testing-library/react';
import { UnderConstruction } from './under-construction';
import { CAPABILITIES } from '@/lib/capabilities';
import { expectNoAxeViolations } from '@/test/harness';

/**
 * The «در حال ساخت» screen has one job: make no claim.
 *
 * The `fetch` assertion is the important one. A placeholder that quietly probed
 * an endpoint would be doing, in the network tab, exactly what the page tells
 * the reader it is not doing — and that is the kind of discrepancy an investor
 * demo cannot survive being caught on.
 */

const NON_LIVE = CAPABILITIES.filter((capability) => capability.state !== 'LIVE');

describe('planned and not-yet-built capabilities', () => {
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
    '%s states that no real transaction happens',
    (_key, capability) => {
      render(<UnderConstruction capabilityKey={capability.key} />);

      expect(screen.getByText('این بخش در حال ساخت است')).toBeInTheDocument();
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
      expect(container.querySelector('svg')).toBeNull();
      expect(container.querySelector('canvas')).toBeNull();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      // No amount, in either digit system.
      expect(container.textContent).not.toMatch(/ریال|[۰-۹]{3}٬/);
    },
  );

  it('has no accessibility violations', async () => {
    const { container } = render(<UnderConstruction capabilityKey="procurement" />);
    await expectNoAxeViolations(container);
  });

  it('fails loudly on an unknown capability rather than rendering nothing', () => {
    // Rendering blank would look like a working-but-empty screen.
    expect(() => render(<UnderConstruction capabilityKey="not-a-capability" />)).toThrow(
      /Unknown capability key/,
    );
  });
});
