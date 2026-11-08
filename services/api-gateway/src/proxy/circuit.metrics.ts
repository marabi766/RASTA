import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * Each downstream's circuit state: 0 CLOSED, 1 HALF_OPEN, 2 OPEN. Labelled by
 * service alone — sixteen series at most; never a tenant, user or request.
 * A service that has never failed has no series (it is CLOSED).
 */
export const circuitStateGauge = new Gauge({
  name: 'rasta_gateway_circuit_state',
  help: 'Gateway circuit breaker state per downstream service (0 closed, 1 half-open, 2 open)',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Requests refused because their own organization (or the no-organization
 * bucket) is shed, while the circuit may be CLOSED for everyone else. Labelled
 * by service alone, for the same reason: never a tenant.
 */
export const circuitShedRefusalsTotal = new Counter({
  name: 'rasta_gateway_circuit_shed_refusals_total',
  help: 'Requests refused because the caller alone is shed from a downstream service',
  labelNames: ['service'] as const,
  registers: [registry],
});
