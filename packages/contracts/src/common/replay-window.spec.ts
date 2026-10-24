import { PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS } from './replay-window';

/**
 * The constant both sides of the project-create replay window are held to (PM decision D-067). The
 * arithmetic of the defaults is asserted where each default lives (`apps/web/src/server/env.spec.ts`,
 * `services/construction-service/src/config/env.spec.ts`); this pins the number itself, so changing it
 * is a visible, reviewed act on both sides.
 */
describe('PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS', () => {
  it('is 3 300 s (55 minutes), a whole number of seconds', () => {
    expect(PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS).toBe(3300);
    expect(Number.isInteger(PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS)).toBe(true);
  });

  it('fits inside the shortest retention the service allows (1 h) with its default fence budget', () => {
    // 3 600 − B(67) − default skew(30) = 3 503 ≥ K
    expect(3600 - 67 - 30).toBeGreaterThanOrEqual(PROJECT_CREATE_MAX_REPLAY_WINDOW_SECONDS);
  });
});
