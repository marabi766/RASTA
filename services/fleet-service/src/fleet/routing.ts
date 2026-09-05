import type { z } from 'zod';
import { FLEET_EVENT_SCHEMAS, FLEET_EVENTS, type FleetEventName } from './events';

/**
 * Where each fleet event goes on the wire.
 *
 * The same shape ADR-036 established for the economic, marketplace and
 * document domains, introduced here as part of ADR-051 Phase B3. Until now the
 * decision lived at each call site, repeated in six places with the reasoning
 * written out three times — which is how a policy erodes: the seventh call site
 * copies the fifth and nobody notices the key changed.
 *
 * Nothing about the routing changes. Every key below is the key that call site
 * already passed; this file only moves the decision to one place and makes it
 * exhaustive under the type checker.
 *
 * **The stream is `topic + partitionKey` (ADR-051 § C-7).** So this file also
 * decides what B3 allocates a sequence against, which is the second reason it
 * cannot stay scattered: two call sites that disagreed about a key would be
 * two streams for one machine, each with its own counter.
 */

export type FleetPayload<N extends FleetEventName> = z.infer<(typeof FLEET_EVENT_SCHEMAS)[N]>;

/** The aggregate each event is *about*, which is not always what orders it. */
export const AGGREGATE_OF = {
  DRIVER_REGISTERED: 'Driver',
  DRIVER_STATUS_CHANGED: 'Driver',
  ASSET_ASSIGNED: 'Assignment',
  ASSIGNMENT_ENDED: 'Assignment',
  USAGE_RECORDED: 'UsageRecord',
  AVAILABILITY_CHANGED: 'AvailabilityWindow',
} as const satisfies Record<FleetEventName, string>;

export const PARTITION_SCOPES = {
  ASSET: 'ASSET',
  DRIVER: 'DRIVER',
} as const;

export type PartitionScope = (typeof PARTITION_SCOPES)[keyof typeof PARTITION_SCOPES];

export interface PartitionDecision {
  readonly scope: PartitionScope;
  readonly key: string;
}

type PartitionRule<N extends FleetEventName> = (payload: FleetPayload<N>) => PartitionDecision;

/**
 * The one place a fleet event's Kafka key is decided.
 *
 * A mapped type over the event union, so adding a name to `FLEET_EVENTS`
 * without deciding how it is ordered fails `pnpm typecheck` rather than
 * quietly inheriting the aggregate id.
 *
 * Two scopes, and the split is the accepted one (ADR-051 § B4, Q-36):
 *
 *   **asset-scoped** — everything that happens *to a machine*. `ASSET_ASSIGNED`
 *   is keyed by asset rather than by assignment because asset-service builds
 *   the machine's dossier from this stream: if the assign and the later release
 *   landed on different partitions, Kafka would guarantee nothing about their
 *   order and a released machine could stay stuck in ASSIGNED (docs/07 § 7.7).
 *   `USAGE_RECORDED` and `AVAILABILITY_CHANGED` follow for the same reason —
 *   every consumer reasons about one machine's readings in order.
 *
 *   **driver-scoped** — a driver's own lifecycle, which no asset orders. These
 *   keep the driver id, which is also what the aggregate default gave them
 *   before this file existed, so their routing is unchanged.
 *
 * **No ordering is claimed between this topic and `rasta.maintenance.v1`,**
 * even for the same `assetId`. Two databases, two counters, no shared lock —
 * ADR-051 § C-7 and the plan's § B4 note say so explicitly, and a negative test
 * holds it.
 */
export const PARTITION_KEY_POLICY: { [N in FleetEventName]: PartitionRule<N> } = {
  // ---- Asset-scoped: one partition per machine ----------------------------
  ASSET_ASSIGNED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  ASSIGNMENT_ENDED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  USAGE_RECORDED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),
  AVAILABILITY_CHANGED: (payload) => ({ scope: 'ASSET', key: payload.assetId }),

  // ---- Driver-scoped: one partition per driver ----------------------------
  DRIVER_REGISTERED: (payload) => ({ scope: 'DRIVER', key: payload.driverId }),
  DRIVER_STATUS_CHANGED: (payload) => ({ scope: 'DRIVER', key: payload.driverId }),
};

/**
 * Resolves the partition key from the **validated** payload.
 *
 * Read off the payload rather than off a variable at the call site, so the key
 * and what the consumer sees cannot disagree — and so the sequence B3
 * allocates belongs to the stream the message is actually published on.
 */
export function resolvePartitionKey(
  eventName: FleetEventName,
  payload: unknown,
): PartitionDecision {
  const rule = PARTITION_KEY_POLICY[eventName] as PartitionRule<FleetEventName>;
  const decision = rule(payload as FleetPayload<FleetEventName>);
  if (!decision.key) {
    throw new Error(
      `Fleet routing: ${eventName} resolved to an empty partition key. ` +
        'An event without a stream cannot be ordered or sequenced.',
    );
  }
  return decision;
}

/** Every event this service produces, for the exhaustiveness tests. */
export const PRODUCED_EVENTS = Object.values(FLEET_EVENTS);
