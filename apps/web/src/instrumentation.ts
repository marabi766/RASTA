/**
 * Refuses to start a production server whose configuration is incomplete.
 *
 * Next.js calls `register()` once when a server process starts. Without it,
 * the environment is read lazily — the first request that needs it fails,
 * after the process has already reported itself healthy. In production that
 * is the wrong order: a portal missing its session key, its identity
 * provider or `WEB_REDIS_URL` (two replicas, `docs/12` § 12.4) should never
 * take traffic, so it exits with status 1 and does not come up at all.
 *
 * Development and test keep the lazy read, where a half-configured portal is
 * a normal thing to be running. `next build` is skipped: building an image
 * needs no runtime secrets, and must not.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { loadWebServerEnv } = await import('./server/env');
  try {
    loadWebServerEnv();
  } catch (error) {
    // Next.js reports a rejected `register()` and then keeps the process up,
    // answering 500 to everything — alive to a TCP health check and useless
    // to everybody else. A server that must not take traffic has to stop: the
    // rejection below is what reports why (names only, never values), and the
    // exit follows once it has been.
    setImmediate(() => process.exit(1));
    throw error;
  }
}
