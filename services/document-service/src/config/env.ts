import { z } from 'zod';
import {
  authEnvSchema,
  baseEnvSchema,
  booleanEnv,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
} from '@rasta/config';

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

    /**
     * Whether a document whose scan **completed without inspecting anything**
     * may be downloaded.
     *
     * This is the temporary decision Q-18 forces, and it is narrow on purpose.
     * It does **not** relax the two rules ADR-014 actually states: a `PENDING`
     * document — one no scan pass has reached — and an `INFECTED` one are
     * refused unconditionally and are not configurable at all.
     *
     * What it governs is only `NOT_SCANNED`: the verdict the MVP stub records
     * because Q-18 is open and no scanner exists to bind. With this `false`,
     * an MVP deployment can store contracts and licences and never hand any of
     * them back, which makes the platform's document capability inert. With it
     * `true`, downloads work and every response says plainly that the content
     * was not examined.
     *
     * The default is `true` **only** because no scanner exists yet. The moment
     * a real one is wired in, its verdicts become `CLEAN` or `INFECTED`,
     * `NOT_SCANNED` stops occurring, and this setting stops mattering — which
     * is the property that makes it safe to have at all. It is recorded in
     * `docs/24` under Q-18 rather than left as a surprise in a schema.
     */
    DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD: booleanEnv(true),
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

export function corsOrigins(env: DocumentEnv): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
