import { z } from 'zod';

/**
 * The platform's record of every executed DLQ replay (D-039, ADR-061 § 3,
 * docs/runbooks/replay-dlq.md).
 *
 * The operator's replay tool (`scripts/replay-dlq.mjs`, the `ops-replay`
 * principal) republishes a dead letter on its topic's `.retry` twin. Each
 * replay that lands there is then recorded here — one `REPLAY_EXECUTED` per
 * replayed event, published **after** the replay is on `.retry`, never before
 * and never as a separate "started" record — and audit-service stores it,
 * append-only, like its other evidence (ADR-053).
 *
 * `ops-replay` is the topic's only producer (`TOPIC_PRODUCERS`), so the broker's
 * per-topic ACL is what authenticates a record here: no service can write one.
 * `operator` is the name the credential's holder gave (`REPLAY_OPERATOR`) — the
 * claim of whoever holds the `ops-replay` credential, recorded as such.
 *
 * What a record carries: ids and positions, never the replayed event's payload.
 */

/** The topic, its own and not a domain topic: audit-service reads it apart. */
export const OPS_REPLAY_TOPIC = 'rasta.ops.replay.v1';

/** The principal and `envelope.producer` of every record on it. */
export const OPS_REPLAY_PRODUCER = 'ops-replay';

export const REPLAY_EXECUTED = 'REPLAY_EXECUTED';

/** A breaking change is a `replayExecutedPayloadSchemaV2` beside this one. */
export const REPLAY_EXECUTED_VERSION = 1;

/** `rpl-` and a UUID: the id the tool gives one run and its report. */
export const REPLAY_REPORT_ID_PATTERN =
  /^rpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An operator named in the environment: a login or an address, never a secret. */
export const REPLAY_OPERATOR_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** The aggregate a record belongs to: one run of the tool. */
export const REPLAY_RUN_AGGREGATE = 'ReplayRun';

const TOPIC_NAME = /^rasta\.[a-z0-9.-]{1,240}$/;
const EVENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const OFFSET = /^(0|[1-9]\d{0,18})$/;

/** Where a record sits: a topic, a partition, an offset (a decimal string — an int64). */
export const replayPositionSchema = z
  .object({
    topic: z.string().regex(TOPIC_NAME),
    partition: z.number().int().nonnegative().max(1_000_000),
    offset: z.string().regex(OFFSET),
  })
  .strict();
export type ReplayPosition = z.infer<typeof replayPositionSchema>;

/**
 * `REPLAY_EXECUTED` v1.
 *
 * `replayedEvent.tenantId` is the replayed event's tenant, and the envelope's
 * `tenantId` must be the same value — or both absent, for an event with no
 * tenant, whose record is platform-scoped (ADR-053 §§ 5, 10).
 * `stale` is the verdict the replay ran under: `false`, or — named by
 * `--allow-stale` — `true` or `'UNKNOWN'`.
 */
export const replayExecutedPayloadSchemaV1 = z
  .object({
    reportId: z.string().regex(REPLAY_REPORT_ID_PATTERN),
    operator: z.string().regex(REPLAY_OPERATOR_PATTERN),
    replayedEvent: z
      .object({
        eventId: z.string().min(1).max(128),
        eventName: z.string().regex(EVENT_NAME),
        tenantId: z.string().min(1).max(128).optional(),
      })
      .strict(),
    dlq: replayPositionSchema,
    target: replayPositionSchema,
    stale: z.union([z.boolean(), z.literal('UNKNOWN')]),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (!payload.dlq.topic.endsWith('.dlq')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dlq', 'topic'],
        message: 'a replay reads a dead-letter topic',
      });
    }
    if (!payload.target.topic.endsWith('.retry')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['target', 'topic'],
        message: 'a replay writes a .retry topic',
      });
    }
  });
export type ReplayExecutedPayloadV1 = z.infer<typeof replayExecutedPayloadSchemaV1>;
