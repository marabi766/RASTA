import { ASSET_SYNC_TOPICS } from '../config/env';
import {
  DrainCheckError,
  INSURANCE_EVENT_TOPICS,
  checkConsumerGroupDrained,
  type LagAdmin,
} from './drain-check.command';

/**
 * The lag arithmetic and the "shown, not inferred" rules, against a fake of the
 * part of kafkajs's `Admin` it uses.
 *
 * Why not a real broker: the integration environment's principals may read the
 * existing topics but not create topics or groups, so a test cannot put a group
 * a known number of messages behind. The shapes below are kafkajs's
 * (`fetchTopicOffsets` → `{partition, offset, high, low}`, `fetchOffsets` →
 * `{topic, partitions: [{partition, offset}]}`, `-1` for "nothing committed",
 * `describeGroups` → `state: 'Dead'` for a group the broker does not know); the
 * broker-facing wiring is `drain-check.cli.ts`, run by hand in the runbook.
 */
describe('insurance:drain-check — consumer lag (#240 r5, r6)', () => {
  const GROUP = 'fleet-service.asset-sync';
  type Partitions = [low: number, high: number, committed: number][];

  /** The four expected topics, each caught up on one partition holding `n` messages. */
  const caught = (n = 3): Record<string, Partitions> => ({
    'rasta.asset.v1': [[0, n, n]],
    'rasta.asset.v1.retry': [[0, n, n]],
    'rasta.insurance.v1': [[0, n, n]],
    'rasta.insurance.v1.retry': [[0, n, n]],
  });

  /** Partitions per topic: `[low, high, committed]`; committed `-1` is "none". */
  function admin(
    topics: Record<string, Partitions>,
    options: { groupState?: string | null } = {},
  ): LagAdmin {
    const state = options.groupState === undefined ? 'Stable' : options.groupState;
    return {
      listTopics: async () => Object.keys(topics),
      fetchTopicOffsets: async (topic) =>
        (topics[topic] ?? []).map(([low, high], partition) => ({
          partition,
          low: String(low),
          high: String(high),
        })),
      fetchOffsets: async ({ topics: wanted }) =>
        wanted.map((topic) => ({
          topic,
          partitions: (topics[topic] ?? []).map(([, , committed], partition) => ({
            partition,
            offset: String(committed),
          })),
        })),
      describeGroups: async (ids) => ({
        groups: state === null ? [] : ids.map((groupId) => ({ groupId, state })),
      }),
    };
  }

  it('expects exactly the topics the group is configured to consume', () => {
    for (const topic of INSURANCE_EVENT_TOPICS) {
      expect(ASSET_SYNC_TOPICS as readonly string[]).toContain(topic);
    }
  });

  it('is drained when every partition is committed up to its high watermark', async () => {
    const report = await checkConsumerGroupDrained(
      admin({
        ...caught(),
        'rasta.asset.v1': [
          [0, 10, 10],
          [0, 4, 4],
        ],
      }),
      GROUP,
    );
    expect(report).toEqual({
      drained: true,
      groupFound: true,
      lagByTopic: {},
      uncommitted: [],
      topics: [
        'rasta.asset.v1',
        'rasta.asset.v1.retry',
        'rasta.insurance.v1',
        'rasta.insurance.v1.retry',
      ],
    });
  });

  it('refuses with the lag per topic when one partition is behind', async () => {
    const report = await checkConsumerGroupDrained(
      admin({
        ...caught(),
        'rasta.asset.v1': [
          [0, 10, 10],
          [0, 9, 6],
        ],
      }),
      GROUP,
    );
    expect(report.drained).toBe(false);
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1': 3 });
  });

  it('does not count messages retention has already removed', async () => {
    const report = await checkConsumerGroupDrained(
      admin({ ...caught(), 'rasta.asset.v1': [[5, 8, 2]] }),
      GROUP,
    );
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1': 3 });
  });

  it('refuses on the lag of a .retry twin', async () => {
    const report = await checkConsumerGroupDrained(
      admin({ ...caught(), 'rasta.asset.v1.retry': [[0, 2, 1]] }),
      GROUP,
    );
    expect(report.drained).toBe(false);
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1.retry': 1 });
  });

  describe('absence is not drained', () => {
    it('a group the broker does not know (state Dead) is not drained', async () => {
      const report = await checkConsumerGroupDrained(
        admin(caught(), { groupState: 'Dead' }),
        GROUP,
      );
      expect(report).toMatchObject({ drained: false, groupFound: false });
    });

    it('a group the broker does not list at all is not drained', async () => {
      const report = await checkConsumerGroupDrained(admin(caught(), { groupState: null }), GROUP);
      expect(report).toMatchObject({ drained: false, groupFound: false });
    });

    it('a partition holding messages with no committed offset is not drained, even when retention emptied it', async () => {
      const report = await checkConsumerGroupDrained(
        admin({
          ...caught(),
          // low === high: no lag arithmetic can see anything behind, yet the group never committed.
          'rasta.insurance.v1': [
            [0, 7, 7],
            [9, 9, -1],
          ],
        }),
        GROUP,
      );
      expect(report.drained).toBe(false);
      expect(report.uncommitted).toEqual(['rasta.insurance.v1/1']);
    });

    it('an uncommitted partition with messages counts its lag from the log start too', async () => {
      const report = await checkConsumerGroupDrained(
        admin({ ...caught(), 'rasta.asset.v1': [[2, 12, -1]] }),
        GROUP,
      );
      expect(report.drained).toBe(false);
      expect(report.lagByTopic).toEqual({ 'rasta.asset.v1': 10 });
      expect(report.uncommitted).toEqual(['rasta.asset.v1/0']);
    });

    it('a partition that never held a message needs no committed offset', async () => {
      const report = await checkConsumerGroupDrained(
        admin({ ...caught(), 'rasta.insurance.v1.retry': [[0, 0, -1]] }),
        GROUP,
      );
      expect(report.drained).toBe(true);
    });

    it('a missing expected topic — a .retry twin included — is a failure, not a pass', async () => {
      const { 'rasta.asset.v1.retry': _twin, ...withoutTwin } = caught();
      await expect(checkConsumerGroupDrained(admin(withoutTwin), GROUP)).rejects.toThrow(
        DrainCheckError,
      );
      const { 'rasta.insurance.v1': _base, ...withoutBase } = caught();
      await expect(checkConsumerGroupDrained(admin(withoutBase), GROUP)).rejects.toThrow(
        DrainCheckError,
      );
    });

    it('fails closed when a topic reports no partitions', async () => {
      await expect(
        checkConsumerGroupDrained(admin({ ...caught(), 'rasta.asset.v1': [] }), GROUP),
      ).rejects.toThrow(DrainCheckError);
    });
  });
});
