/**
 * Which data source this build talks to.
 *
 * ## Why this is one exact string and nothing else
 *
 * `fixture` is selected only when `NEXT_PUBLIC_DEMO_DATA_MODE` is exactly the
 * literal `"fixture"`. Not `"1"`, not `"true"`, not a truthy check, and — most
 * importantly — **never** as a consequence of anything going wrong at runtime.
 *
 * That last point is the whole design. The obvious convenience would be to fall
 * back to fixtures when a live request fails, and it is exactly the wrong
 * behaviour: an audience watching a screen full of plausible data has no way to
 * know the backend is down, and neither does the presenter. A live failure must
 * stay a visible failure. So the mode is decided once, from configuration, before
 * any request is made, and nothing can change it afterwards.
 *
 * The mirror of that rule is that a *fixture* session must never quietly reach
 * the network either. `FixtureGatewayClient` has no `fetch` and no token to send.
 */

export const DEMO_DATA_MODES = ['live', 'fixture'] as const;

export type DemoDataMode = (typeof DEMO_DATA_MODES)[number];

/** The one value that turns fixtures on. Exported so tests cannot mistype it. */
export const FIXTURE_MODE_VALUE = 'fixture';

/**
 * Reads the configured mode.
 *
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time only where the full
 * member expression appears in source, so it is written out literally here
 * rather than read through an index — the same reason `lib/env.ts` does it.
 */
export function readDemoDataMode(
  raw: string | undefined = process.env.NEXT_PUBLIC_DEMO_DATA_MODE,
): DemoDataMode {
  return raw?.trim() === FIXTURE_MODE_VALUE ? 'fixture' : 'live';
}

export function isFixtureMode(mode: DemoDataMode): boolean {
  return mode === 'fixture';
}

/**
 * The identity a fixture session presents.
 *
 * Deliberately not a plausible person. Every field announces itself: the name
 * says «شبیه‌سازی‌شده», the ids carry a `demo` segment, and the address is on
 * `example.invalid` — a domain reserved by RFC 2606 precisely so it can never
 * resolve to anyone real.
 *
 * There is **no token here, and no token anywhere in fixture mode**. The fixture
 * client needs no credential because it makes no request, so a fixture session
 * has nothing to leak, nothing to persist and nothing to renew. It never touches
 * `oidc-client-ts`, which keeps it entirely off the production authentication
 * path rather than merely beside it.
 */
export const DEMO_IDENTITY = {
  subject: 'demo-subject-not-a-real-account',
  userId: 'usr_demo_presenter',
  displayName: 'کاربر نمایشی (شبیه‌سازی‌شده)',
  email: 'presenter@example.invalid',
  roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'PROCUREMENT_USER'] as const,
  organizationId: 'org_demo_dehyari_alef',
  organizationIds: ['org_demo_dehyari_alef', 'org_demo_dehyari_beh'] as const,
} as const;

/** The banner wording. One constant, so a test can assert it verbatim. */
export const FIXTURE_DISCLOSURE =
  'حالت نمایشی — داده‌های این صفحه ساختگی‌اند و از سرویس‌های واقعی خوانده نمی‌شوند';

export const LIVE_DISCLOSURE = 'حالت زنده — داده‌ها از درگاه API واقعی خوانده می‌شوند';
