import { registry } from '@rasta/observability';
import { settlementFailuresTotal } from './metrics';

/**
 * The refusal alert's series exists before the first refusal (docs/24 Q-29;
 * review of #364 round 1, F4): `RastaSettlementNoActiveRule` is an
 * `increase()`, which needs a sample before the first refusal to see one.
 */
describe('rasta_economic_settlement_failures_total', () => {
  it('exports reason="no_active_rule" at zero from startup, before any settlement', async () => {
    const { values } = await settlementFailuresTotal.get();
    expect(values).toEqual([
      { labels: { service: 'economic-service', reason: 'no_active_rule' }, value: 0 },
    ]);
    expect(await registry.metrics()).toMatch(
      /^rasta_economic_settlement_failures_total\{service="economic-service",reason="no_active_rule"\} 0$/m,
    );
  });

  it('counts the first refusal from that zero', async () => {
    settlementFailuresTotal.inc({ service: 'economic-service', reason: 'no_active_rule' });
    const { values } = await settlementFailuresTotal.get();
    expect(values).toEqual([
      { labels: { service: 'economic-service', reason: 'no_active_rule' }, value: 1 },
    ]);
  });
});
