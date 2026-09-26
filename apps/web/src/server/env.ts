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
