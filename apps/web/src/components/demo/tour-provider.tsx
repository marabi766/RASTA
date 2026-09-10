'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { isFixtureMode } from '@/lib/demo/mode';
import { resolveTourStops, type ResolvedTourStop } from '@/lib/demo/tour';
import { useSession } from '@/lib/auth/session';

/**
 * The guided tour's state, held above the router.
 *
 * ## Why this is a provider rather than page state
 *
 * The tour navigates. Every step is a real route change into a real screen, so
 * state owned by any one page would be destroyed by the very act of advancing.
 * Holding it in the portal layout — which survives navigation between portal
 * routes — is what makes "next" work at all.
 *
 * ## Why it is also in `sessionStorage`
 *
 * A layout survives client-side navigation but not a reload, and a presenter
 * who refreshes mid-demo should not be dropped back to step one in front of an
 * audience. The stored value is a step number and a boolean; it is not a
 * credential, and `sessionStorage` means a closed tab forgets it.
 */

export interface TourValue {
  readonly active: boolean;
  readonly index: number;
  readonly stops: readonly ResolvedTourStop[];
  readonly current: ResolvedTourStop | null;
  /** Longer presenter text, toggled from the toolbar. */
  readonly detailed: boolean;
  start(): void;
  exit(): void;
  restart(): void;
  next(): void;
  previous(): void;
  goTo(index: number): void;
  setDetailed(detailed: boolean): void;
}

const TourContext = createContext<TourValue | null>(null);

const TOUR_STATE_KEY = 'rasta.tour.state';

interface StoredTour {
  readonly active: boolean;
  readonly index: number;
  readonly detailed: boolean;
}

export function TourProvider({ children }: { children: ReactNode }): ReactNode {
  const router = useRouter();
  const { dataMode } = useSession();

  // Resolved once per mode. `resolveTourStops` throws on an unknown capability
  // key, which is deliberate: a tour that silently dropped a stop would
  // renumber every step after it, and "step 4 of 11" would quietly become a
  // different screen than the presenter rehearsed.
  const stops = useMemo(() => resolveTourStops(isFixtureMode(dataMode)), [dataMode]);

  const [state, setState] = useState<StoredTour>({ active: false, index: 0, detailed: true });

  // Restored after mount rather than in the initializer: the server render has
  // no `sessionStorage`, and reading it during the first client render would
  // produce markup that disagrees with what the server sent.
  useEffect(() => {
    const restored = readStoredTour();
    if (restored) setState(restored);
  }, []);

  useEffect(() => {
    writeStoredTour(state);
  }, [state]);

  const goTo = useCallback(
    (index: number) => {
      const clamped = Math.min(stops.length - 1, Math.max(0, index));
      const stop = stops[clamped];
      if (!stop) return;

      setState((current) => ({ ...current, active: true, index: clamped }));
      router.push(stop.href);
    },
    [router, stops],
  );

  const start = useCallback(() => goTo(0), [goTo]);
  const restart = useCallback(() => goTo(0), [goTo]);

  const exit = useCallback(() => {
    // The step is kept rather than reset. A presenter who exits to answer a
    // question and then restarts almost never means "from the beginning", and
    // `restart` is right there for when they do.
    setState((current) => ({ ...current, active: false }));
  }, []);

  const next = useCallback(() => goTo(state.index + 1), [goTo, state.index]);
  const previous = useCallback(() => goTo(state.index - 1), [goTo, state.index]);

  const setDetailed = useCallback((detailed: boolean) => {
    setState((current) => ({ ...current, detailed }));
  }, []);

  const value = useMemo<TourValue>(
    () => ({
      active: state.active,
      index: state.index,
      detailed: state.detailed,
      stops,
      current: stops[state.index] ?? null,
      start,
      exit,
      restart,
      next,
      previous,
      goTo,
      setDetailed,
    }),
    [state, stops, start, exit, restart, next, previous, goTo, setDetailed],
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourValue {
  const value = useContext(TourContext);
  if (!value) throw new Error('useTour must be used inside <TourProvider>');
  return value;
}

/**
 * The tour, if there is one.
 *
 * For components that are useful with or without it — a «در حال ساخت» screen
 * offers "continue the tour" when a tour is running and "back to the
 * presentation" when it is not, and it has to render either way. Throwing here
 * would make those screens depend on a presentation feature they are not part
 * of, and would fail them in any test that mounts one on its own.
 *
 * `useTour` stays strict for the overlay and toolbar, which genuinely cannot
 * work without a provider and should say so loudly if one goes missing.
 */
export function useOptionalTour(): TourValue | null {
  return useContext(TourContext);
}

/**
 * Storage access, wrapped.
 *
 * A browser can refuse `sessionStorage` outright — private modes and hardened
 * configurations throw on access rather than returning null. Losing the tour
 * position is a degraded experience; crashing the portal on first paint is not
 * an acceptable trade for it.
 */
function readStoredTour(): StoredTour | null {
  try {
    const raw = window.sessionStorage.getItem(TOUR_STATE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const record = parsed as Record<string, unknown>;
    if (typeof record.index !== 'number' || !Number.isInteger(record.index)) return null;

    return {
      active: record.active === true,
      index: Math.max(0, record.index),
      detailed: record.detailed !== false,
    };
  } catch {
    return null;
  }
}

function writeStoredTour(state: StoredTour): void {
  try {
    window.sessionStorage.setItem(TOUR_STATE_KEY, JSON.stringify(state));
  } catch {
    /* see readStoredTour */
  }
}
