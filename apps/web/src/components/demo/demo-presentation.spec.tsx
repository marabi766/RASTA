import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { CAPABILITIES, capabilityByKey, mayCallNetwork } from '@/lib/capabilities';
import { FIXTURE_DISCLOSURE } from '@/lib/demo/mode';
import { TOUR_STOPS, TourItineraryError, resolveTourStops } from '@/lib/demo/tour';
import { SessionContext, type SessionValue } from '@/lib/auth/session';
import { STATE_PRESENTATION } from '../capability';
import { expectNoAxeViolations, makeHarness } from '@/test/harness';
import { AssetsView } from '../assets/assets-view';
import { DemoModeBanner, DemoModeChip } from './mode-banner';
import { TourOverlay } from './tour-overlay';
import { TourProvider, useTour } from './tour-provider';

/**
 * The presentation layer's honesty and its keyboard.
 *
 * Two unrelated-looking concerns in one file because they fail the same way. A
 * demo is a claim made to people who cannot inspect the system, so the two
 * things that must never go wrong are the claim being wrong — a `LIVE` badge on
 * something planned, a fixture screen with no disclosure — and the presenter
 * being unable to move, which is what a tour that traps focus or eats the
 * arrow keys amounts to in a room with an audience in it.
 */

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => '/demo',
}));

function fixtureSession(): SessionValue {
  return makeHarness({ dataMode: 'fixture' }).session;
}

function renderInTour(ui: ReactElement, session: SessionValue = fixtureSession()): void {
  const Wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <SessionContext.Provider value={session}>
      <TourProvider>{children}</TourProvider>
    </SessionContext.Provider>
  );

  render(ui, { wrapper: Wrapper });
}

beforeEach(() => {
  window.sessionStorage.clear();
  push.mockClear();
});

describe('the fixture disclosure', () => {
  it('states the exact wording in fixture mode', () => {
    render(
      <SessionContext.Provider value={fixtureSession()}>
        <DemoModeBanner />
      </SessionContext.Provider>,
    );

    // Verbatim. A paraphrase in a screenshot is a different claim.
    expect(screen.getByTestId('fixture-disclosure')).toHaveTextContent(FIXTURE_DISCLOSURE);
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('renders nothing at all in live mode', () => {
    const { container } = render(
      <SessionContext.Provider value={makeHarness().session}>
        <DemoModeBanner />
      </SessionContext.Provider>,
    );

    // Not hidden, not empty-but-present — absent. There is nothing to disclose
    // about real data, and a bar that sometimes says nothing is a bar people
    // stop reading before the day it needs to say something.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('fixture-disclosure')).not.toBeInTheDocument();
  });

  /**
   * The banner is mounted once, in the shell, above everything a page renders.
   * Asserting its position in source is what makes "always visible" true of
   * every screen rather than of the screens a test happened to mount.
   */
  it('sits above the page content on every screen in the shell', () => {
    const shell = readFileSync(path.join(__dirname, '..', 'app-shell.tsx'), 'utf8');

    const banner = shell.indexOf('<DemoModeBanner />');
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(shell.indexOf('<TopBar />'));
    expect(banner).toBeLessThan(shell.indexOf('<main'));

    // Unconditional at the mount site: the component decides by mode, and no
    // page can opt out of it.
    expect(shell).not.toMatch(/\{[^}]*<DemoModeBanner\s*\/>/);
  });

  it('names the mode in the toolbar chip, in both modes', () => {
    const { rerender } = render(
      <SessionContext.Provider value={fixtureSession()}>
        <DemoModeChip />
      </SessionContext.Provider>,
    );
    expect(screen.getByText('FIXTURE')).toBeInTheDocument();
    expect(screen.getByText('دادهٔ نمایشی')).toBeInTheDocument();

    rerender(
      <SessionContext.Provider value={makeHarness().session}>
        <DemoModeChip />
      </SessionContext.Provider>,
    );
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.queryByText('FIXTURE')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <SessionContext.Provider value={fixtureSession()}>
        <DemoModeBanner />
      </SessionContext.Provider>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('the tour states only what the registry states', () => {
  it('names a real capability at every stop', () => {
    for (const stop of TOUR_STOPS) {
      expect(capabilityByKey(stop.capabilityKey)).toBeDefined();
    }
  });

  it('refuses to resolve an itinerary that points nowhere', () => {
    // Throwing beats skipping: a dropped stop renumbers every step after it,
    // and "step 4 of 11" quietly becomes a screen nobody rehearsed.
    expect(() =>
      resolveTourStops(false, [{ id: 'ghost', capabilityKey: 'no-such-capability' }]),
    ).toThrow(TourItineraryError);
  });

  it('copies no status of its own', () => {
    const resolved = resolveTourStops(false);

    for (const stop of resolved) {
      const registry = capabilityByKey(stop.capabilityKey);
      expect(stop.capability.state).toBe(registry?.state);
      expect(stop.capability.title).toBe(registry?.title);
    }

    // The itinerary file must not contain a state name; if it did, it would be
    // a second place where a capability's status is written down.
    const source = readFileSync(path.join(__dirname, '..', '..', 'lib', 'demo', 'tour.ts'), 'utf8');
    const code = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const state of ['LIVE', 'BETA', 'PLANNED', 'BACKEND_READY', 'PREVIEW']) {
      expect(code).not.toContain(state);
    }
  });

  it('shows the tour every state the registry uses, including an unbuilt one', () => {
    const states = new Set(resolveTourStops(false).map((stop) => stop.capability.state));

    // A tour of only the finished parts is the dishonest edit. The last stop is
    // a planned capability on purpose.
    expect(states.has('LIVE')).toBe(true);
    expect(states.has('PLANNED')).toBe(true);
  });

  it('deep-links only where the dataset can answer', () => {
    const live = resolveTourStops(false);
    const fixture = resolveTourStops(true);

    for (const [index, stop] of live.entries()) {
      // A live tenant has no record with a known id, so live mode must land on
      // the list screen — a deep link would 404 on every deployment but this one.
      expect(stop.href).toBe(stop.capability.href);

      const counterpart = fixture[index]!;
      expect(counterpart.href).toBe(stop.fixtureHref ?? stop.capability.href);
    }
  });
});

describe('the guided tour keyboard and focus', () => {
  it('renders nothing until a tour is started', () => {
    renderInTour(<TourOverlay />);
    expect(screen.queryByTestId('tour-overlay')).not.toBeInTheDocument();
  });

  it('moves focus to the step heading when a step opens', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));

    const heading = await screen.findByRole('heading', { level: 2 });
    // Without this a route change leaves focus wherever it was, and a
    // screen-reader user gets no announcement that the step changed at all.
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveAttribute('aria-live', 'polite');
  });

  it('moves focus again on the next step', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');

    await userEvent.tab();
    expect(screen.getByRole('heading', { level: 2 })).not.toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'گام بعدی' }));

    await waitFor(() => expect(screen.getByRole('heading', { level: 2 })).toHaveFocus());
    expect(screen.getByText(/گام ۲ از/)).toBeInTheDocument();
  });

  it('navigates to the stop the step names', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');

    const stops = resolveTourStops(true);
    expect(push).toHaveBeenLastCalledWith(stops[0]!.href);

    await userEvent.click(screen.getByRole('button', { name: 'گام بعدی' }));
    expect(push).toHaveBeenLastCalledWith(stops[1]!.href);
  });

  it('exits on Escape', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('tour-overlay')).not.toBeInTheDocument());
  });

  /**
   * The arrow keys belong to the page.
   *
   * Every stop is a real screen — a table that scrolls, a select that opens —
   * and a tour that stole the arrows to move between steps would break the very
   * pages it exists to show.
   */
  it('leaves the arrow keys to the screen behind it', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');
    const before = push.mock.calls.length;

    await userEvent.keyboard('{ArrowRight}{ArrowLeft}{ArrowDown}{ArrowUp}');

    expect(screen.getByText(/گام ۱ از/)).toBeInTheDocument();
    expect(push.mock.calls).toHaveLength(before);
  });

  it('cannot step past either end', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');

    expect(screen.getByRole('button', { name: 'گام پیشین' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'گام بعدی' })).toBeEnabled();
  });

  it('badges the current stop with the state the registry holds', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');

    const first = resolveTourStops(true)[0]!;
    expect(screen.getByText(STATE_PRESENTATION[first.capability.state].label)).toBeInTheDocument();
  });

  it('has no accessibility violations while running', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    const overlay = await screen.findByTestId('tour-overlay');
    await expectNoAxeViolations(overlay.parentElement as HTMLElement);
  });
});

describe('what the tour writes down', () => {
  it('persists a step number and nothing resembling a credential', async () => {
    renderInTour(
      <>
        <StartButton />
        <TourOverlay />
      </>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'شروع' }));
    await screen.findByTestId('tour-overlay');

    const stored = window.sessionStorage.getItem('rasta.tour.state');
    expect(stored).not.toBeNull();
    expect(Object.keys(JSON.parse(stored!) as object).sort()).toEqual([
      'active',
      'detailed',
      'index',
    ]);

    // sessionStorage, not localStorage, and a step number either way.
    expect(window.localStorage.length).toBe(0);
  });

  it('survives a storage backend that refuses to work', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        // A hardened browser throws on access rather than returning null.
        throw new Error('SecurityError');
      },
    });

    try {
      // Losing the tour position is a degraded experience; crashing the portal
      // on first paint in front of an audience is not an acceptable trade.
      expect(() => renderInTour(<TourOverlay />)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});

describe('every planned capability has a screen to land on', () => {
  const PORTAL = path.join(__dirname, '..', '..', 'app', '(portal)');
  /**
   * Every capability with no screen of its own — which is not the same as every
   * capability that is not `LIVE`. `BETA` reaches a real adapter and has a real
   * screen; it is the states that may not touch the network that need a
   * placeholder to land on.
   */
  const UNBUILT = CAPABILITIES.filter((capability) => !mayCallNetwork(capability));

  it('has planned capabilities to route to', () => {
    expect(UNBUILT.length).toBeGreaterThan(0);
    expect(UNBUILT.every((capability) => capability.state !== 'BETA')).toBe(true);
  });

  it.each(UNBUILT.map((capability) => [capability.key, capability.href] as const))(
    '%s routes to a page that renders the honest screen',
    (key, href) => {
      // The route file has to exist, or the navigation the dashboard and the
      // tour both offer ends at a 404 during a presentation.
      const page = path.join(PORTAL, ...href.split('/').filter(Boolean), 'page.tsx');
      const source = readFileSync(page, 'utf8');

      expect(source).toContain('UnderConstruction');
      expect(source).toContain(`capabilityKey="${key}"`);
      // No data reading of any kind on a screen that has no data.
      expect(source).not.toMatch(/useApiResource|fetch\(|adapter/i);
    },
  );
});

describe('a live failure stays a failure', () => {
  /**
   * The structural proof that fixtures are unreachable from an error path lives
   * in `lib/demo/demo-mode.spec.ts`. This is the same rule seen from the other
   * end: a live screen whose request fails shows the failure, and shows no
   * invented record in its place.
   *
   * The tempting bug — falling back to fixtures when the gateway is down —
   * would leave an audience looking at a full, plausible screen with nothing
   * anywhere indicating that the backend never answered.
   */
  it('shows the error rather than substituting fixture data', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));

    const { container } = render(
      <SessionContext.Provider value={session}>
        <AssetsView />
      </SessionContext.Provider>,
    );

    await screen.findByRole('alert');

    const { FIXTURE_RESPONSES } = await import('@/lib/demo/fixtures');
    const text = container.textContent ?? '';

    // Nothing from the dataset, by name or by identifier.
    expect(text).not.toContain('گریدر نمونه ۱');
    for (const id of Object.keys(FIXTURE_RESPONSES)) expect(text).not.toContain(id);
    expect(text).not.toContain('demo');

    // The mode did not move either.
    expect(session.dataMode).toBe('live');
    expect(screen.queryByTestId('fixture-disclosure')).not.toBeInTheDocument();
  });
});

describe('nothing from the wire reaches the screen', () => {
  it('shows a backend failure without quoting the backend', async () => {
    const { fetchMock, session } = makeHarness();
    // The harness error body carries an upstream English message and a token
    // sits on the session — neither may appear on screen.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'INTERNAL',
            message: 'upstream english text',
            stack: 'at PrismaClient._request (/srv/node_modules/@prisma/client)',
            correlationId: 'cid-gateway',
            timestamp: new Date().toISOString(),
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { container } = render(
      <SessionContext.Provider value={session}>
        <AssetsView />
      </SessionContext.Provider>,
    );

    await screen.findByRole('alert');

    const text = container.textContent ?? '';
    expect(text).not.toContain('upstream english text');
    expect(text).not.toContain('PrismaClient');
    expect(text).not.toContain('token-test');
    expect(text).not.toMatch(/Bearer/i);
    // The Persian message the platform owns, and the correlation id a user can
    // legitimately quote to support, are what remains.
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  it('sends the token as a header and never as anything the page can read', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const { container } = render(
      <SessionContext.Provider value={session}>
        <AssetsView />
      </SessionContext.Provider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-test');
    // Not in the URL, not in the markup, not in storage.
    expect(url).not.toContain('token-test');
    expect(container.innerHTML).not.toContain('token-test');
    expect(window.localStorage.length).toBe(0);
  });
});

/** Starts the tour from outside the overlay, the way the toolbar does. */
function StartButton(): ReactNode {
  const { start } = useTour();
  return <button onClick={start}>شروع</button>;
}
