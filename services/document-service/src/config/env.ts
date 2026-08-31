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

    // ---- Scanning (ADR-014, Q-18) ----------------------------------------
    //
    // There is deliberately no `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` here.
    //
    // It existed and defaulted to `true`, which turned the MVP stub's
    // `NOT_SCANNED` verdict into a download. ADR-014 requires that a file stay
    // unavailable until scanning has completed, so that default contradicted
    // an accepted ADR and made the platform's out-of-the-box posture the
    // permissive one. It was removed rather than re-defaulted to `false`: a
    // setting whose only purpose is to switch off a security invariant is a
    // runtime bypass, and the deployment that flips it will not be the one
    // that reads this comment.
    //
    // Which scanner to bind is still open (Q-18), and that is a composition
    // decision — a class behind `MalwareScanner` — not an environment
    // variable. Until one exists, uploads and metadata registration work and
    // downloads are refused. `docs/24` records the consequence.
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
