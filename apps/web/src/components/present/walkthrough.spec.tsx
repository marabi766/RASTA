import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Walkthrough } from './walkthrough';
import { WALKTHROUGH, WALKTHROUGH_MINUTES } from './steps';
import { CAPABILITIES, capabilityByKey } from '@/lib/capabilities';
import { expectNoAxeViolations } from '@/test/harness';

/**
 * The guided walkthrough.
 *
 * The script is the part of this application most likely to drift, because it
 * is prose about the product rather than code that calls it. These tests tie it
 * back to the manifest: a step cannot point at a capability that does not
 * exist, and a step's status badge cannot disagree with the dashboard.
 */

describe('the script', () => {
  it('fits the stated 10–15 minute slot with a little room', () => {
    expect(WALKTHROUGH_MINUTES).toBeGreaterThanOrEqual(10);
    expect(WALKTHROUGH_MINUTES).toBeLessThanOrEqual(20);
  });

  it('points every step at a capability that exists', () => {
    for (const step of WALKTHROUGH) {
      if (!step.capabilityKey) continue;
      expect(capabilityByKey(step.capabilityKey)).toBeDefined();
    }
  });

  it('lands on at least one capability from every product area it claims to cover', () => {
    const covered = new Set(
      WALKTHROUGH.map((step) => step.capabilityKey)
        .filter((key): key is string => Boolean(key))
        .map((key) => capabilityByKey(key)?.domain),
    );

    // Fleet, commerce, finance and platform all have live capabilities, so a
    // tour that skipped one would be leaving working product on the table.
    expect(covered).toContain('fleet');
    expect(covered).toContain('commerce');
    expect(covered).toContain('finance');
    expect(covered).toContain('platform');
  });

  it('ends on something the platform does not do', () => {
    // The last impression should be the honesty, not a feature.
    const last = WALKTHROUGH[WALKTHROUGH.length - 1];
    expect(capabilityByKey(last!.capabilityKey!)?.state).toBe('PLANNED');
  });

  it('gives every step both an action and a point', () => {
    for (const step of WALKTHROUGH) {
      expect(step.action.trim().length).toBeGreaterThan(20);
      expect(step.point.trim().length).toBeGreaterThan(40);
    }
  });

  it('uses unique step ids', () => {
    expect(new Set(WALKTHROUGH.map((step) => step.id)).size).toBe(WALKTHROUGH.length);
  });
});

describe('navigating the tour', () => {
  it('starts on the first step with the previous control disabled', () => {
    render(<Walkthrough />);

    expect(screen.getByText(WALKTHROUGH[0]!.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'گام پیشین' })).toBeDisabled();
  });

  it('advances and goes back', async () => {
    const user = userEvent.setup();
    render(<Walkthrough />);

    await user.click(screen.getByRole('button', { name: 'گام بعدی' }));
    expect(screen.getByRole('heading', { name: WALKTHROUGH[1]!.title })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'گام پیشین' }));
    expect(screen.getByRole('heading', { name: WALKTHROUGH[0]!.title })).toBeInTheDocument();
  });

  it('jumps to a step from the progress list', async () => {
    const user = userEvent.setup();
    render(<Walkthrough />);

    await user.click(screen.getByRole('button', { name: new RegExp(WALKTHROUGH[4]!.title) }));
    expect(screen.getByRole('heading', { name: WALKTHROUGH[4]!.title })).toBeInTheDocument();
  });

  it('advances on the left arrow, because that is "next" in RTL', async () => {
    const user = userEvent.setup();
    render(<Walkthrough />);

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('heading', { name: WALKTHROUGH[1]!.title })).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('heading', { name: WALKTHROUGH[0]!.title })).toBeInTheDocument();
  });

  it('stops at the last step rather than wrapping', async () => {
    const user = userEvent.setup();
    render(<Walkthrough />);

    for (let index = 0; index < WALKTHROUGH.length + 3; index += 1) {
      await user.keyboard('{ArrowLeft}');
    }

    expect(
      screen.getByRole('heading', { name: WALKTHROUGH[WALKTHROUGH.length - 1]!.title }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'گام بعدی' })).toBeDisabled();
  });

  it('toggles presentation mode with f and leaves it with Escape', async () => {
    const user = userEvent.setup();
    render(<Walkthrough />);

    await user.keyboard('f');
    expect(screen.getByRole('button', { name: /خروج از حالت ارائه/ })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'حالت ارائه' })).toBeInTheDocument();
  });
});

describe('status stays tied to the manifest', () => {
  it('shows the capability badge the dashboard would show', async () => {
    const user = userEvent.setup();
    render(<Walkthrough />);

    // Step two lands on `profile`, which is LIVE.
    await user.click(screen.getByRole('button', { name: 'گام بعدی' }));
    const capability = capabilityByKey(WALKTHROUGH[1]!.capabilityKey!);
    expect(screen.getByText(capability!.state)).toBeInTheDocument();
  });

  it('does not invent a capability the manifest has no entry for', () => {
    const keys = new Set(CAPABILITIES.map((entry) => entry.key));
    for (const step of WALKTHROUGH) {
      if (step.capabilityKey) expect(keys.has(step.capabilityKey)).toBe(true);
    }
  });
});

describe('accessibility', () => {
  it('has no violations', async () => {
    const { container } = render(<Walkthrough />);
    await expectNoAxeViolations(container);
  });
});
