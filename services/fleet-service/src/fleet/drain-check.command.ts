/**
 * The fleet half of the drain fence that guards a change of
 * `INSURANCE_COVERAGES_FOLLOWING_VEHICLE` (docs/runbooks/insurance-reprojection.md,
 * #240 round 5).
 *
 * An insurance event already on the broker was built under the old following
 * rule. Consumed after `clear-transferred`, it recreates a window the clear
 * removed; the asset locks order local writes only. So, with asset-service
 * stopped, fleet's asset-sync consumer group must have **no lag** on the topics
 * those events travel on, and only then may the clear run.
 *
 * Lag is read from the broker, not from fleet's own tables: the group's
 * committed offset against the topic's high watermark, partition by partition.
 * A partition the group never committed on counts from the log start — a group
 * that has consumed nothing is behind by everything still retained.
 */

/** The slice of kafkajs's `Admin` this check uses; a test passes a fake. */
export interface LagAdmin {
  listTopics(): Promise<string[]>;
  fetchTopicOffsets(topic: string): Promise<{ partition: number; high: string; low: string }[]>;
  fetchOffsets(options: {
    groupId: string;
    topics: string[];
  }): Promise<{ topic: string; partitions: { partition: number; offset: string }[] }[]>;
}

/**
 * The topics the insurance events travel on. The `.retry` twins carry replays
 * of the same events (D-039); they are read when they exist.
 */
export const INSURANCE_EVENT_TOPICS = ['rasta.asset.v1', 'rasta.insurance.v1'] as const;

export interface LagReport {
  drained: boolean;
  /** Messages the group has yet to commit past, per topic that has any. */
  lagByTopic: Record<string, number>;
  /** Topics read, `.retry` twins that do not exist excluded. */
  topics: string[];
}

export class DrainCheckError extends Error {}

export async function checkConsumerGroupDrained(
  admin: LagAdmin,
  groupId: string,
  baseTopics: readonly string[] = INSURANCE_EVENT_TOPICS,
): Promise<LagReport> {
  const existing = new Set(await admin.listTopics());
  // A missing base topic is not "no lag": nothing can be said about events on
  // a topic this principal cannot see, so the check fails closed.
  const missing = baseTopics.filter((topic) => !existing.has(topic));
  if (missing.length > 0) {
    throw new DrainCheckError(`topic ${missing.join(', ')} not found; the lag cannot be read`);
  }
  const topics = baseTopics.flatMap((topic) =>
    existing.has(`${topic}.retry`) ? [topic, `${topic}.retry`] : [topic],
  );

  const committed = new Map<string, string>();
  for (const { topic, partitions } of await admin.fetchOffsets({ groupId, topics })) {
    for (const { partition, offset } of partitions) committed.set(`${topic}/${partition}`, offset);
  }

  const lagByTopic: Record<string, number> = {};
  for (const topic of topics) {
    const log = await admin.fetchTopicOffsets(topic);
    if (log.length === 0) throw new DrainCheckError(`topic ${topic} reports no partitions`);
    for (const { partition, high, low } of log) {
      const done = Number(committed.get(`${topic}/${partition}`) ?? '-1');
      // -1: nothing committed. Behind by everything the log still holds.
      const lag = Number(high) - (done < 0 ? Number(low) : Math.max(done, Number(low)));
      if (lag > 0) lagByTopic[topic] = (lagByTopic[topic] ?? 0) + lag;
    }
  }
  return { drained: Object.keys(lagByTopic).length === 0, lagByTopic, topics };
}
