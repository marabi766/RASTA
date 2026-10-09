import { DrainCheckError, checkConsumerGroupDrained, type LagAdmin } from './drain-check.command';

/**
 * The lag arithmetic, against a fake of the part of kafkajs's `Admin` it uses.
 *
 * Why not a real broker: the integration environment's principals may read the
 * existing topics but not create topics or groups, so a test cannot put a group
 * a known number of messages behind. The shapes below are kafkajs's
 * (`fetchTopicOffsets` → `{partition, offset, high, low}`, `fetchOffsets` →
 * `{topic, partitions: [{partition, offset}]}`, `-1` for "nothing committed");
 * the broker-facing wiring is `drain-check.cli.ts`, run by hand in the runbook.
 */
describe('insurance:drain-check — consumer lag (#240 r5)', () => {
  const GROUP = 'fleet-service.asset-sync';

  /** Partitions per topic: `[low, high, committed]`; committed `-1` is "none". */
  function admin(
    topics: Record<string, [low: number, high: number, committed: number][]>,
  ): LagAdmin & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      listTopics: async () => Object.keys(topics),
      fetchTopicOffsets: async (topic) => {
        asked.push(topic);
        return (topics[topic] ?? []).map(([low, high], partition) => ({
          partition,
          low: String(low),
          high: String(high),
        }));
      },
      fetchOffsets: async ({ topics: wanted }) =>
        wanted.map((topic) => ({
          topic,
          partitions: (topics[topic] ?? []).map(([, , committed], partition) => ({
            partition,
            offset: String(committed),
          })),
        })),
    };
  }

  it('is drained when every partition is committed up to its high watermark', async () => {
    const report = await checkConsumerGroupDrained(
      admin({
        'rasta.asset.v1': [
          [0, 10, 10],
          [0, 4, 4],
        ],
        'rasta.insurance.v1': [[0, 7, 7]],
      }),
      GROUP,
    );
    expect(report).toEqual({
      drained: true,
      lagByTopic: {},
      topics: ['rasta.asset.v1', 'rasta.insurance.v1'],
    });
  });

  it('refuses with the lag per topic when one partition is behind', async () => {
    const report = await checkConsumerGroupDrained(
      admin({
        'rasta.asset.v1': [
          [0, 10, 10],
          [0, 9, 6],
        ],
        'rasta.insurance.v1': [[0, 7, 7]],
      }),
      GROUP,
    );
    expect(report.drained).toBe(false);
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1': 3 });
  });

  it('counts a partition the group never committed on from the log start', async () => {
    const report = await checkConsumerGroupDrained(
      admin({ 'rasta.asset.v1': [[2, 12, -1]], 'rasta.insurance.v1': [[0, 0, -1]] }),
      GROUP,
    );
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1': 10 });
  });

  it('does not count messages retention has already removed', async () => {
    const report = await checkConsumerGroupDrained(
      admin({ 'rasta.asset.v1': [[5, 8, 2]], 'rasta.insurance.v1': [[0, 0, 0]] }),
      GROUP,
    );
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1': 3 });
  });

  it('also reads a .retry twin when it exists, and refuses on its lag', async () => {
    const report = await checkConsumerGroupDrained(
      admin({
        'rasta.asset.v1': [[0, 3, 3]],
        'rasta.asset.v1.retry': [[0, 2, 1]],
        'rasta.insurance.v1': [[0, 3, 3]],
      }),
      GROUP,
    );
    expect(report.topics).toContain('rasta.asset.v1.retry');
    expect(report.lagByTopic).toEqual({ 'rasta.asset.v1.retry': 1 });
  });

  it('does not require a .retry twin that does not exist', async () => {
    const report = await checkConsumerGroupDrained(
      admin({ 'rasta.asset.v1': [[0, 3, 3]], 'rasta.insurance.v1': [[0, 3, 3]] }),
      GROUP,
    );
    expect(report.topics).toEqual(['rasta.asset.v1', 'rasta.insurance.v1']);
  });

  it('fails closed when a base topic is not visible, rather than reading it as no lag', async () => {
    await expect(
      checkConsumerGroupDrained(admin({ 'rasta.asset.v1': [[0, 3, 3]] }), GROUP),
    ).rejects.toThrow(DrainCheckError);
  });

  it('fails closed when a topic reports no partitions', async () => {
    await expect(
      checkConsumerGroupDrained(admin({ 'rasta.asset.v1': [], 'rasta.insurance.v1': [] }), GROUP),
    ).rejects.toThrow(DrainCheckError);
  });
});
