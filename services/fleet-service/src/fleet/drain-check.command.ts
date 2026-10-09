/**
 * The fleet half of the drain fence that guards a change of
 * `INSURANCE_COVERAGES_FOLLOWING_VEHICLE` (docs/runbooks/insurance-reprojection.md,
 * #240 rounds 5 and 6).
 *
 * An insurance event already on the broker was built under the old following
 * rule. Consumed after `clear-transferred`, it recreates a window the clear
 * removed; the asset locks order local writes only. So, with asset-service
 * stopped, fleet's asset-sync consumer group must have **no lag** on the topics
 * those events travel on, and only then may the clear run.
 *
 * Lag is read from the broker, not from fleet's own tables: the group's
 * committed offset against the topic's high watermark, partition by partition.
 * "No lag" has to be shown, not inferred from absence:
 *
 *   - the group must **exist** — one the broker does not know has committed
 *     nothing, and reads as "nothing to do" to a check that only sums lag;
 *   - every **expected** topic, the `.retry` twins included, must exist; a
 *     missing one is a failure (the list is fleet's own configuration, not
 *     whatever happens to be on the broker);
 *   - every **partition** of them must have a committed offset, unless it has
 *     never held a message (high watermark 0), where no commit can exist.
 *
 * The verification of each insurance event at asset-service (#240 round 6)
 * makes this fence advisable rather than load-bearing; it is kept because it is
 * cheap and stops events being applied one at a time against a rule in flux.
 */

/** The slice of kafkajs's `Admin` this check uses; a test passes a fake. */
export interface LagAdmin {
  listTopics(): Promise<string[]>;
  fetchTopicOffsets(topic: string): Promise<{ partition: number; high: string; low: string }[]>;
  fetchOffsets(options: {
    groupId: string;
    topics: string[];
  }): Promise<{ topic: string; partitions: { partition: number; offset: string }[] }[]>;
  /** A group the broker does not know is reported in the `Dead` state. */
  describeGroups(groupIds: string[]): Promise<{ groups: { groupId: string; state: string }[] }>;
}

/**
 * The topics the insurance events travel on. Their `.retry` twins carry
 * replays of the same events (D-039) and are expected as well.
 */
export const INSURANCE_EVENT_TOPICS = ['rasta.asset.v1', 'rasta.insurance.v1'] as const;

/** Every topic the check reads: the base topics and their `.retry` twins. */
export const expectedTopics = (baseTopics: readonly string[]): string[] =>
  baseTopics.flatMap((topic) => [topic, `${topic}.retry`]);

export interface LagReport {
  drained: boolean;
  /** Whether the broker knows the group. */
  groupFound: boolean;
  /** Messages the group has yet to commit past, per topic that has any. */
  lagByTopic: Record<string, number>;
  /** `topic/partition` of every partition with messages and no committed offset. */
  uncommitted: string[];
  /** Topics read. */
  topics: string[];
}

/** The check could not be made (exit 2), as opposed to made and failed (exit 1). */
export class DrainCheckError extends Error {}

export async function checkConsumerGroupDrained(
  admin: LagAdmin,
  groupId: string,
  baseTopics: readonly string[] = INSURANCE_EVENT_TOPICS,
): Promise<LagReport> {
  const topics = expectedTopics(baseTopics);
  const existing = new Set(await admin.listTopics());
  // A missing expected topic is not "no lag": nothing can be said about events
  // on a topic this principal cannot see, so the check fails closed.
  const missing = topics.filter((topic) => !existing.has(topic));
  if (missing.length > 0) {
    throw new DrainCheckError(`topic ${missing.join(', ')} not found; the lag cannot be read`);
  }

  const described = (await admin.describeGroups([groupId])).groups.find(
    (group) => group.groupId === groupId,
  );
  if (!described || described.state === 'Dead') {
    return { drained: false, groupFound: false, lagByTopic: {}, uncommitted: [], topics };
  }

  const committed = new Map<string, string>();
  for (const { topic, partitions } of await admin.fetchOffsets({ groupId, topics })) {
    for (const { partition, offset } of partitions) committed.set(`${topic}/${partition}`, offset);
  }

  const lagByTopic: Record<string, number> = {};
  const uncommitted: string[] = [];
  for (const topic of topics) {
    const log = await admin.fetchTopicOffsets(topic);
    if (log.length === 0) throw new DrainCheckError(`topic ${topic} reports no partitions`);
    for (const { partition, high, low } of log) {
      const done = Number(committed.get(`${topic}/${partition}`) ?? '-1');
      if (done < 0) {
        // -1: nothing committed. Fine only where nothing was ever written.
        if (Number(high) > 0) uncommitted.push(`${topic}/${partition}`);
        const lag = Number(high) - Number(low);
        if (lag > 0) lagByTopic[topic] = (lagByTopic[topic] ?? 0) + lag;
        continue;
      }
      const lag = Number(high) - Math.max(done, Number(low));
      if (lag > 0) lagByTopic[topic] = (lagByTopic[topic] ?? 0) + lag;
    }
  }
  return {
    drained: Object.keys(lagByTopic).length === 0 && uncommitted.length === 0,
    groupFound: true,
    lagByTopic,
    uncommitted,
    topics,
  };
}
