import { registry } from '@rasta/observability';
import { observeRevocationList } from './revocation.metrics';

const NAMES = [
  'rasta_gateway_revocation_list_entries',
  'rasta_gateway_revocation_feed_staleness_seconds',
  'rasta_gateway_revocation_feed_lag_records',
];

afterEach(() => observeRevocationList(undefined));

describe('revocation gauges (FU-276)', () => {
  it('off: import alone exports no list or feed gauges', async () => {
    const text = await registry.metrics();
    for (const name of NAMES) {
      expect(registry.getSingleMetric(name)).toBeUndefined();
      expect(text).not.toContain(name);
    }
  });

  it('observed: zero entries is distinct from off, unknown feed values are -1', async () => {
    observeRevocationList({
      size: () => 0,
      stalenessSeconds: () => undefined,
      lag: () => undefined,
    });
    const text = await registry.metrics();
    for (const [index, value] of [0, -1, -1].entries())
      expect(text).toContain(`${NAMES[index]} ${value}\n`);
  });

  it('collects live values and removes all gauges when observation stops', async () => {
    let value = 2;
    const source = { size: () => value, stalenessSeconds: () => value, lag: () => value };
    observeRevocationList(source);
    for (value of [2, 0]) {
      observeRevocationList(source);
      const text = await registry.metrics();
      for (const name of NAMES) expect(text).toContain(`${name} ${value}\n`);
    }
    observeRevocationList(undefined);
    const text = await registry.metrics();
    for (const name of NAMES) expect(text).not.toContain(name);
  });
});
