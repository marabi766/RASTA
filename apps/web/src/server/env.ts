import { z } from 'zod';

/**
 * Server-only configuration for the portal (ADR-059).
 *
 * Every value here is read on the server and **none of it is prefixed
 * `NEXT_PUBLIC_`**, which is what keeps it out of the browser bundle. That is
 * not a style preference: `docs/16 § ۱۶٫۱۱` forbids a secret in a
 * `NEXT_PUBLIC_` variable, and Next.js decides what ships to the browser by
 * exactly that prefix.
 *
 * ## Why a missing session key refuses the boot
 *
 * The same shape `ECONOMIC_PAYMENT_PROVIDER` and `NOTIFICATION_MAIL_ADAPTER`
 * already use in this repository. A portal that started without a key would
 * have to do one of two things with the session cookie: leave it unencrypted,
 * or invent a key at startup. The first hands anybody who can read a cookie a
 * working refresh token. The second logs every user out on every deploy and on
 * every replica that happens to answer, which reads as an outage nobody can
 * reproduce. Refusing to start is the honest third option.
 */

/** Long enough that a key is a key rather than a password somebody typed. */
const MIN_SECRET_LENGTH = 32;

/**
 * A URL a browser or a server could actually fetch.
 *
 * `z.string().url()` alone accepts `gateway:3000`, because that parses as a
 * URL with the scheme `gateway:`. It would then be stored, joined against and
 * fetched, and the failure would surface as a connection error at runtime
 * rather than as a refusal at boot — which is the whole point of validating
 * configuration.
 */
const httpUrl = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('http://') || value.startsWith('https://'),
    'Expected an http(s) URL',
  );

/** The oversight role has aggregate access only; no setting here may grant it a screen. */
const OVERSIGHT_ROLE = 'AUDITOR';

/** The platform administrator, whom inventory-service refuses too (Q-103). */
const PLATFORM_ROLE = 'SYSTEM_ADMIN';

/**
 * A comma-separated role list, trimmed, empty elements dropped, never naming the
 * oversight role — nor any other role in `alsoRefused`.
 */
function roleList(name: string, fallback: string, alsoRefused: readonly string[] = []) {
  const refused = [OVERSIGHT_ROLE, ...alsoRefused];
  return z
    .string()
    .default(fallback)
    .transform((raw) =>
      raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    )
    .refine((roles) => !roles.some((role) => refused.includes(role)), {
      message: `${name} may not name ${refused.join(' or ')}`,
    });
}

const schema = z.object({
  /**
   * The only origin this portal's server code is allowed to call.
   *
   * ADR-058 § 3 and ADR-059 § 3: every cross-cutting control — JWT
   * verification, tenant resolution, rate limiting, correlation, the circuit
   * breaker — lives in the gateway. `gateway.ts` refuses any other host, and a
   * test holds that rather than a sentence in a README.
   */
  API_GATEWAY_URL: httpUrl,

  /** Keycloak realm issuer. The discovery document hangs off it. */
  OIDC_ISSUER_URL: httpUrl,
  /** The public client the development realm already ships (`rasta-web`). */
  OIDC_CLIENT_ID: z.string().min(1),

  /**
   * Where Keycloak sends the browser back, as the browser sees it.
   *
   * Explicit rather than derived from the request host: a redirect URI built
   * from a header is a redirect URI an attacker can influence, and Keycloak
   * matches it exactly against its registered list.
   */
  WEB_PUBLIC_ORIGIN: httpUrl,

  /** 32 bytes or more. Seals the session cookie; never leaves the server. */
  WEB_SESSION_SECRET: z.string().min(MIN_SECRET_LENGTH),

  /**
   * How long a session cookie may live at most, regardless of token lifetimes.
   *
   * A ceiling rather than the whole story: the access token inside it expires
   * far sooner and is refreshed. This bounds how long a stolen cookie is worth
   * anything, which matters because ADR-059 accepts that a sealed session
   * cannot be revoked centrally.
   */
  WEB_SESSION_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(300)
    .max(30 * 24 * 60 * 60)
    .default(12 * 60 * 60),

  /**
   * Whether the session cookie carries `Secure`.
   *
   * Defaults to true, and the only reason it can be turned off is local
   * development over plain HTTP, where a `Secure` cookie is simply never sent
   * and the portal appears to log nobody in.
   */
  /**
   * Redis, for coordinating token refreshes across replicas
   * (`refresh-coordinator.ts`).
   *
   * **Required in production** (see `loadWebServerEnv`): the documented
   * topology runs two replicas (`docs/12` § 12.4), where per-process
   * coordination is not a safe fallback. Optional in development and test,
   * where one process is the norm and a warning says what is missing.
   */
  WEB_REDIS_URL: z
    .string()
    .url()
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'Expected a redis:// or rediss:// URL',
    )
    .optional(),

  /**
   * Which roles are shown the Projects link, and the owner side of the Tenders
   * link (`server/portal-nav.ts`) — construction-service gates both by the
   * same configured roles. The bidder side of Tenders needs `CONTRACTOR`, fixed
   * in the service, so it has no setting.
   *
   * These **mirror** construction-service's `CONSTRUCTION_PROJECT_ROLES`
   * (default `ORGANIZATION_ADMIN`) and `CONSTRUCTION_PROJECT_READER_ROLES`
   * (default none) and must be changed together with them. They decide only
   * whether a link is drawn; the service still decides who may read, and a
   * refusal is rendered as an outcome. `AUDITOR` is refused at boot, as the
   * service refuses it: the oversight role has aggregate access only.
   */
  WEB_PROJECT_ROLES: roleList('WEB_PROJECT_ROLES', 'ORGANIZATION_ADMIN'),
  WEB_PROJECT_READER_ROLES: roleList('WEB_PROJECT_READER_ROLES', ''),

  /**
   * Which roles are shown the Inventory link (`server/portal-nav.ts`).
   *
   * These **mirror** inventory-service's `INVENTORY_OPERATOR_ROLES` and
   * `INVENTORY_READER_ROLES` (both default `ORGANIZATION_ADMIN`, Q-103) and
   * must be changed together with them. They decide only whether a link is
   * drawn; the service still decides who may read. The service refuses
   * `AUDITOR` and `SYSTEM_ADMIN` whatever the configuration says and refuses to
   * start naming either, so the portal does the same.
   */
  WEB_INVENTORY_ROLES: roleList('WEB_INVENTORY_ROLES', 'ORGANIZATION_ADMIN', [PLATFORM_ROLE]),
  WEB_INVENTORY_READER_ROLES: roleList('WEB_INVENTORY_READER_ROLES', 'ORGANIZATION_ADMIN', [
    PLATFORM_ROLE,
  ]),

  /**
   * Which roles are shown the Contracts link, on the employer's side
   * (`server/portal-nav.ts`). The contractor's side needs `CONTRACTOR`, fixed
   * in contract-service (ADR-068 § 7), so it has no setting here — the same
   * shape as the bidder side of Tenders.
   *
   * This **mirrors** contract-service's `CONTRACT_READER_ROLES` (default
   * `ORGANIZATION_ADMIN`) and must be changed together with it. It decides
   * only whether a link is drawn; the service still decides who may read, and
   * a refusal is rendered as an outcome. `AUDITOR` is refused at boot, as the
   * service refuses it on both sides.
   *
   * contract-service has no separate "extra reader" role the way
   * construction-service's projects do, so there is one setting here, not a
   * pair — see docs/16 § ۱۶٫۶ for the note that explains this choice.
   */
  WEB_CONTRACT_READER_ROLES: roleList('WEB_CONTRACT_READER_ROLES', 'ORGANIZATION_ADMIN'),

  /**
   * How long marketplace-service keeps an idempotency record, in hours — the
   * window in which a return command re-sent under its original key is a
   * replay rather than a new command (`server/return-replay.ts`). A return
   * request run again under a fresh record is a **second request** for the
   * same goods, so past this window the portal never re-sends one.
   *
   * This **mirrors** marketplace-service's `MARKETPLACE_IDEMPOTENCY_TTL_HOURS`
   * (same bounds, 1..168) and must be changed together with it, or set lower.
   * The default is that setting's floor, as for economic-service's below.
   */
  WEB_MARKETPLACE_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(1),

  /**
   * How much earlier than that retention the portal stops re-sending a
   * return command, in seconds: room for the request to reach
   * marketplace-service. Same bounds as the dispute margin.
   */
  WEB_RETURN_REPLAY_MARGIN_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 60)
    .default(10 * 60),

  /**
   * How long economic-service keeps an idempotency record, in hours — the
   * window in which a dispute command re-sent under its original key is a
   * replay rather than a new command (`server/dispute-replay.ts`, PR 319
   * review 2, finding 2).
   *
   * This **mirrors** economic-service's `ECONOMIC_IDEMPOTENCY_TTL_HOURS`
   * (same bounds, 1..168) and must be changed together with it, or set lower.
   * The default is that setting's **floor**, not its default: a value lower
   * than the service's only offers the re-send for less time than it could
   * be; a higher one would offer a re-send the service may execute as new.
   */
  WEB_ECONOMIC_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(1),

  /**
   * How much earlier than that retention the portal stops re-sending a
   * dispute command, in seconds: room for the request to travel from the
   * portal to economic-service, so a re-send let through just before the
   * deadline cannot arrive after the record is gone. At most half an hour,
   * so the window is never shorter than thirty minutes.
   */
  WEB_DISPUTE_REPLAY_MARGIN_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 60)
    .default(10 * 60),

  /**
   * How long contract-service keeps an idempotency record, in hours — the
   * window in which a statement command re-sent under its original key is a
   * replay rather than a new command (`server/statement-replay.ts`). A draft
   * run again under a fresh record is a **second statement**, so past this
   * window the portal never re-sends one.
   *
   * This **mirrors** contract-service's `CONTRACT_IDEMPOTENCY_TTL_HOURS`
   * (same bounds, 1..168) and must be changed together with it, or set lower.
   * The default is that setting's floor, as for economic-service's above.
   */
  WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(1),

  /**
   * How much earlier than that retention the portal stops re-sending a
   * statement command, in seconds: room for the request to reach
   * contract-service. Same bounds as the dispute margin.
   */
  WEB_CONTRACT_REPLAY_MARGIN_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 60)
    .default(10 * 60),

  WEB_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type WebServerEnv = z.infer<typeof schema>;

/**
 * Reads and validates the server environment.
 *
 * Takes its source rather than reaching for `process.env`, so the tests
 * exercise the real schema instead of a copy of it.
 */
export function loadWebServerEnv(
  // A plain record rather than `NodeJS.ProcessEnv`: that type requires
  // `NODE_ENV`, and a test would have to supply it to talk about anything
  // else. `NODE_ENV` is read for one rule only: `WEB_REDIS_URL` in production.
  source: Record<string, string | undefined> = process.env,
): WebServerEnv {
  const parsed = schema.safeParse(source);
  const missing = parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));

  // The one rule that depends on where the portal runs. Production is two
  // replicas, and two replicas without shared coordination race for every
  // refresh token (ADR-059 addendum).
  if (source.NODE_ENV === 'production' && !source.WEB_REDIS_URL) missing.push('WEB_REDIS_URL');

  if (!parsed.success || missing.length > 0) {
    // Names only, never values: this object holds the session key.
    throw new Error(
      `The portal cannot start: its server configuration is incomplete or invalid (${missing.join(', ')}). ` +
        'See ADR-059 and .env.example.',
    );
  }
  return parsed.data;
}

let cached: WebServerEnv | undefined;

/** The validated environment, read once per process. */
export function webServerEnv(): WebServerEnv {
  cached ??= loadWebServerEnv();
  return cached;
}
