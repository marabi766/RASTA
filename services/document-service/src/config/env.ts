import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';
import type { ClamdAddress } from '../scanning/clamav/clamd.client';

export const SERVICE_NAME = 'document-service';

/** Every event this service publishes goes to one topic (`docs/07` § 7.3). */
export const DOCUMENT_TOPIC = 'rasta.document.v1';

/**
 * document-service configuration.
 *
 * The storage settings are configuration rather than constants because ADR-014
 * makes swapping MinIO for managed S3 "only a configuration change" — a claim
 * that is only true if nothing about the endpoint, the region, the bucket or
 * the credentials is compiled in.
 *
 * The size and duration bounds are **bounded** rather than merely defaulted.
 * An unbounded signed-URL lifetime is a credential with no expiry, and an
 * unbounded size limit is a way to fill a bucket; a deployment may tune either
 * within a range, but cannot switch the control off by setting a large number.
 */
export const documentEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(kafkaEnvSchema)
  .merge(authEnvSchema)
  .extend({
    CORS_ORIGINS: z.string().default(''),

    // ---- Object storage (ADR-014) ----------------------------------------

    S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    S3_BUCKET_DOCUMENTS: z.string().min(1).default('rasta-documents'),
    /**
     * MinIO addresses buckets by path; AWS S3 by subdomain. Wrong here and
     * every signed URL points at a host that does not exist.
     */
    S3_FORCE_PATH_STYLE: booleanEnv(true),

    /**
     * How long a signed URL is valid, in seconds.
     *
     * ADR-014 fixes the canonical default at five minutes. The bound is the
     * real control: a signed URL is a bearer credential for one object, and
     * anybody holding it needs no token and no role. An hour is the ceiling so
     * that a misconfiguration cannot turn one into something a person can
     * paste into a chat and have work tomorrow.
     */
    DOCUMENT_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    /**
     * How long an upload intent may sit unfinalized, in seconds.
     *
     * Longer than the signed PUT URL it accompanies, because a client that
     * uploaded successfully at the last second must still be able to finalize.
     */
    DOCUMENT_UPLOAD_INTENT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),

    /**
     * The largest object this service will register, in bytes.
     *
     * A ceiling on the per-class limits below rather than a replacement for
     * them: the class policy says what a licence or a photograph may weigh,
     * and this says what the service will accept under any classification.
     */
    DOCUMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(200 * 1024 * 1024)
      .default(25 * 1024 * 1024),

    // ---- Scanning (ADR-014, ADR-049) -------------------------------------
    //
    // There is deliberately no `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` here.
    //
    // It existed and defaulted to `true`, which turned the stub's
    // `NOT_SCANNED` verdict into a download. ADR-014 requires that a file stay
    // unavailable until scanning has completed, so that default contradicted
    // an accepted ADR and made the platform's out-of-the-box posture the
    // permissive one. It was removed rather than re-defaulted to `false`: a
    // setting whose only purpose is to switch off a security invariant is a
    // runtime bypass, and the deployment that flips it will not be the one
    // that reads this comment. Nothing below reintroduces it — every setting
    // here tunes *how* scanning happens, and none of them can make an
    // unscanned document downloadable.

    /**
     * Which implementation is bound behind `MALWARE_SCANNER`.
     *
     * `clamav` is the platform default (ADR-049). `disabled` binds the no-op
     * stub, which records `NOT_SCANNED` and therefore makes every document in
     * that deployment permanently undownloadable — a development convenience
     * for working on upload and metadata without a scanner running, and
     * refused outright in production by the check below.
     *
     * Not a boolean, because the set will grow: a cloud engine is the obvious
     * next member, and `DOCUMENT_SCANNER_ENABLED=false` would have no room for
     * it.
     */
    DOCUMENT_SCANNER_DRIVER: z.enum(['clamav', 'disabled']).default('clamav'),

    /**
     * The clamd Unix domain socket. The production transport.
     *
     * A socket on a volume shared by exactly two containers in one Pod, whose
     * access control is filesystem permissions. AGENTS.md S-08 forbids
     * implicit trust in an internal network, and the clamd protocol has no
     * authentication of any kind — no password, no TLS, no client certificate
     * — so a TCP listener's only protection would be "nothing else is on this
     * network", which is precisely the assumption S-08 names.
     */
    DOCUMENT_CLAMAV_SOCKET_PATH: z.string().min(1).optional(),

    /**
     * clamd over TCP. Local development and CI only, and enforced as such.
     *
     * A Unix socket cannot be shared between a Linux container and a Node
     * process on a Windows host, so `pnpm infra:up` has no way to reach the
     * production transport. The refinement below refuses this combination when
     * `NODE_ENV` is `production` — the process exits at startup rather than
     * warning, because a warning in a boot log is not a control.
     */
    DOCUMENT_CLAMAV_HOST: z.string().min(1).optional(),
    DOCUMENT_CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),

    /**
     * The whole-exchange deadline for one scan, in milliseconds.
     *
     * Bounded at both ends. Too short and a large document can never finish;
     * unbounded and a stalled clamd holds a worker slot indefinitely, which
     * turns one hung scan into a stalled queue.
     */
    DOCUMENT_SCAN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),

    /** Bytes per INSTREAM frame — how much of an object is ever resident. */
    DOCUMENT_SCAN_CHUNK_BYTES: z.coerce.number().int().min(4_096).max(1_048_576).default(65_536),

    /**
     * The largest object this deployment will submit for scanning.
     *
     * Capped below `StreamMaxLength` in `clamd.conf` so the adapter's ceiling
     * is the one that normally fires: a refusal that names this service's
     * policy is diagnosable, and one that surfaces as a clamd protocol error
     * is not. An object above it is recorded `FAILED` and stays
     * undownloadable — never `CLEAN`.
     */
    DOCUMENT_SCAN_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(32 * 1024 * 1024),

    /**
     * How old the signature database may be and still support a `CLEAN`.
     *
     * The default is two days: freshclam updates several times a day, so a
     * database older than that means updating has been failing for a while.
     * Past this age the adapter refuses to scan at all and records
     * `STALE_SIGNATURES` — an absence of matches from an old database is not
     * evidence of anything, and recording it as `CLEAN` would be the quietest
     * possible way to serve malware.
     *
     * A match is treated differently and deliberately: a stale database still
     * finds what it knows, so `INFECTED` stands whatever this says.
     *
     * The ceiling is a year rather than unbounded, so this cannot be set to a
     * number that switches the check off. CI raises it with a written reason —
     * the pinned image's database is frozen at its digest and freshclam is off
     * there for determinism — and freshness itself is proven by a separate job
     * that actually runs freshclam.
     */
    DOCUMENT_SCAN_SIGNATURE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(8_760).default(48),

    /** How long a `zVERSION` reply may be reused before it is asked for again. */
    DOCUMENT_SCAN_VERSION_CACHE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),

    // ---- The scan worker --------------------------------------------------

    /**
     * Whether this replica scans.
     *
     * On by default. It exists so a test can drive the worker deterministically
     * instead of racing a timer, and so an operator can stand up a replica that
     * only serves HTTP during an incident. It cannot make an unscanned document
     * downloadable: with the worker off, documents stay `PENDING`, and
     * `PENDING` is refused.
     */
    DOCUMENT_SCAN_WORKER_ENABLED: booleanEnv(true),

    /** How often a replica looks for claimable work. */
    DOCUMENT_SCAN_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(2_000),

    /** Documents claimed per poll. Bounded, because each one holds a lease. */
    DOCUMENT_SCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(5),

    /**
     * How long a claim is held before another worker may take it.
     *
     * Must exceed `DOCUMENT_SCAN_TIMEOUT_MS` with room to spare, or a scan
     * still running loses its lease and a second worker starts the same
     * document — the write-back is refused, so no contradictory state results,
     * but the work is done twice. Checked at startup by the refinement below
     * rather than left as advice in a comment.
     */
    DOCUMENT_SCAN_LEASE_SECONDS: z.coerce.number().int().min(10).max(3_600).default(300),

    /**
     * Attempts before a document is recorded `FAILED` for good.
     *
     * Finite on purpose. An unbounded retry keeps a permanently broken
     * document in the queue forever, where it competes with real work and
     * where its state says "waiting" rather than "this needs a person".
     */
    DOCUMENT_SCAN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),

    /** First retry delay; doubles per attempt up to the ceiling below. */
    DOCUMENT_SCAN_RETRY_BASE_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),

    DOCUMENT_SCAN_RETRY_MAX_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    const hasSocket = Boolean(env.DOCUMENT_CLAMAV_SOCKET_PATH);
    const hasTcp = Boolean(env.DOCUMENT_CLAMAV_HOST);

    if (env.DOCUMENT_SCANNER_DRIVER === 'clamav') {
      if (!hasSocket && !hasTcp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DOCUMENT_CLAMAV_SOCKET_PATH'],
          message:
            'The ClamAV driver needs an address: set DOCUMENT_CLAMAV_SOCKET_PATH (production) ' +
            'or DOCUMENT_CLAMAV_HOST (local development and CI only).',
        });
      }

      // The S-08 control, enforced at startup.
      //
      // clamd authenticates nobody. Anything that can open its TCP port can
      // submit a stream, read the engine version and enumerate the signature
      // database, and there is no credential to add. So the production
      // transport is a Unix socket on a volume shared inside one Pod, where
      // the access control is filesystem permissions rather than a belief
      // about who else is on the network.
      //
      // Refused rather than warned about. A deployment that reached this state
      // would run, scan, and look entirely healthy while trusting an
      // unauthenticated network endpoint — the failure nobody notices.
      if (production && hasTcp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DOCUMENT_CLAMAV_HOST'],
          message:
            'DOCUMENT_CLAMAV_HOST configures an unauthenticated TCP scanner and is refused in ' +
            'production (AGENTS.md S-08, ADR-049). Use DOCUMENT_CLAMAV_SOCKET_PATH with a ' +
            'sidecar sharing the socket volume.',
        });
      }

      if (production && !hasSocket) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DOCUMENT_CLAMAV_SOCKET_PATH'],
          message: 'A production deployment must reach clamd over a Unix domain socket (ADR-049).',
        });
      }
    }

    // The no-op stub records `NOT_SCANNED`, which is never downloadable — so
    // this is not a security bypass. It is refused in production because a
    // deployment configured this way accepts uploads and can hand back none of
    // them, and discovering that from a support ticket is worse than
    // discovering it from a failed boot.
    if (production && env.DOCUMENT_SCANNER_DRIVER === 'disabled') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DOCUMENT_SCANNER_DRIVER'],
        message:
          'DOCUMENT_SCANNER_DRIVER=disabled binds a scanner that inspects nothing, which leaves ' +
          'every document undownloadable. It is a development setting and is refused in ' +
          'production (ADR-049).',
      });
    }

    // A lease that expires while its scan is still running gets the document
    // picked up twice. The write-back is conditional on holding the lease, so
    // nothing contradictory is stored — but the work is repeated, and on a
    // busy queue that compounds.
    if (env.DOCUMENT_SCAN_LEASE_SECONDS * 1000 <= env.DOCUMENT_SCAN_TIMEOUT_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DOCUMENT_SCAN_LEASE_SECONDS'],
        message:
          'DOCUMENT_SCAN_LEASE_SECONDS must exceed DOCUMENT_SCAN_TIMEOUT_MS, or a scan still ' +
          'running loses its claim and is started again by another worker.',
      });
    }
  });

export type DocumentEnv = z.infer<typeof documentEnvSchema>;

export function loadDocumentEnv(source: NodeJS.ProcessEnv = process.env): DocumentEnv {
  return loadEnv(documentEnvSchema, {
    ...source,
    SERVICE_NAME: source.SERVICE_NAME ?? SERVICE_NAME,
    PORT: source.PORT ?? source.PORT_DOCUMENT ?? '3114',
    DATABASE_URL: source.DATABASE_URL ?? source.DATABASE_URL_DOCUMENT,
    KAFKA_CLIENT_ID: source.KAFKA_CLIENT_ID ?? SERVICE_NAME,
    KAFKA_CONSUMER_GROUP: source.KAFKA_CONSUMER_GROUP ?? `${SERVICE_NAME}.main`,
    CORS_ORIGINS: source.CORS_ORIGINS ?? source.GATEWAY_CORS_ORIGINS ?? '',
  });
}

/**
 * Where clamd is, derived once (ADR-049).
 *
 * The socket wins when both are set. A deployment that carried a leftover
 * `DOCUMENT_CLAMAV_HOST` alongside a socket path would otherwise pick whichever
 * the code happened to check first, and the safer transport should never lose
 * that coin toss. Production cannot reach the TCP branch at all — the schema
 * refuses that combination before this runs.
 */
export function clamdAddress(env: DocumentEnv): ClamdAddress {
  if (env.DOCUMENT_CLAMAV_SOCKET_PATH) {
    return { transport: 'unix', socketPath: env.DOCUMENT_CLAMAV_SOCKET_PATH };
  }
  if (env.DOCUMENT_CLAMAV_HOST) {
    return { transport: 'tcp', host: env.DOCUMENT_CLAMAV_HOST, port: env.DOCUMENT_CLAMAV_PORT };
  }
  // Unreachable through `loadDocumentEnv`, which refuses the ClamAV driver
  // with no address. Thrown rather than defaulted, because a default here
  // would be a guess about where a security component lives.
  throw new Error('No clamd address is configured');
}

export function corsOrigins(env: DocumentEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
