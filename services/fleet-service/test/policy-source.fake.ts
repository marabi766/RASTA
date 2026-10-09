import { RastaError } from '@rasta/nest-common';
import type { InsurancePolicySource, PolicyVerdict } from '../src/consumers/replica-sources';

/** What the replica shows for the asset, so the default source can agree with it. */
export type ReplicaView = (
  assetId: string,
) =>
  | { organizationId?: string | null; ownershipGeneration?: number | null }
  | null
  | Promise<{ organizationId?: string | null; ownershipGeneration?: number | null } | null>;

/**
 * asset-service's answer about a recorded policy, in-process (ADR-061 § 4).
 *
 * An `INSURANCE_RECORDED` is applied only after asset-service confirms the
 * policy counts, so a test that feeds one to the consumer has to say what the
 * source answers. By default it is the happy path: {@link echoing} makes the
 * source confirm what the event states — for the owner and ownership
 * generation the replica shows (the source and the replica agree), so the only
 * thing a default test varies is the event. A test about the source disagreeing
 * sets the verdict itself ({@link set}, {@link deny}) or takes it down
 * ({@link unreachable}); an explicit verdict is never overwritten by the echo.
 *
 * Like the real route, a counting verdict is given to its owner only: asked as
 * anyone else it is `counts: false, NOT_CURRENT_OWNER`, with no owner named.
 */
export class FakePolicySource implements InsurancePolicySource {
  readonly asked: { organizationId: string; assetId: string; policyId: string }[] = [];
  /** Set by the test's consumer builder: what the replica shows now. */
  replica: ReplicaView = () => null;
  private readonly verdicts = new Map<string, PolicyVerdict>();
  private readonly explicit = new Set<string>();
  private down = false;

  /** The source confirms the policy as the event states it, unless a verdict was set. */
  async echo(payload: Record<string, unknown>): Promise<void> {
    const policyId = payload.policyId;
    if (typeof policyId !== 'string' || this.explicit.has(policyId)) return;
    const shown = await this.replica(String(payload.assetId));
    const eventGeneration =
      typeof payload.ownershipGeneration === 'number' ? payload.ownershipGeneration : 0;
    this.verdicts.set(policyId, {
      counts: true,
      organizationId: shown?.organizationId ?? String(payload.organizationId),
      coverage: String(payload.coverage),
      validFrom: String(payload.validFrom),
      validUntil: String(payload.validTo),
      ownershipGeneration: shown?.ownershipGeneration ?? eventGeneration,
    });
  }

  set(policyId: string, verdict: PolicyVerdict): this {
    this.verdicts.set(policyId, verdict);
    this.explicit.add(policyId);
    return this;
  }

  deny(policyId: string, reason = 'NOT_FOLLOWING_VEHICLE'): this {
    return this.set(policyId, { counts: false, reason });
  }

  unreachable(down = true): this {
    this.down = down;
    return this;
  }

  async verify(organizationId: string, assetId: string, policyId: string): Promise<PolicyVerdict> {
    this.asked.push({ organizationId, assetId, policyId });
    if (this.down) throw RastaError.upstreamUnavailable('asset-service');
    const verdict = this.verdicts.get(policyId) ?? { counts: false, reason: 'UNKNOWN_POLICY' };
    if (verdict.counts && verdict.organizationId !== organizationId) {
      return { counts: false, reason: 'NOT_CURRENT_OWNER' };
    }
    return verdict;
  }
}

/** Makes `consumer.handle` register an `INSURANCE_RECORDED`'s own statement as the source's answer. */
export function echoing<T extends { handle: (...args: never[]) => Promise<unknown> }>(
  consumer: T,
  source: FakePolicySource,
): T {
  const handle = consumer.handle.bind(consumer) as (...args: unknown[]) => Promise<unknown>;
  (consumer as { handle: unknown }).handle = async (...args: unknown[]) => {
    const envelope = args[0] as { eventName?: string; payload?: Record<string, unknown> };
    if (envelope.eventName === 'INSURANCE_RECORDED' && envelope.payload) {
      await source.echo(envelope.payload);
    }
    return handle(...args);
  };
  return consumer;
}
