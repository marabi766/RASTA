import { RastaError } from '@rasta/nest-common';
import type { InsurancePolicySource, PolicyVerdict } from '../src/consumers/replica-sources';

/**
 * asset-service's answer about a recorded policy, in-process (ADR-061 § 4).
 *
 * An `INSURANCE_RECORDED` is applied only after asset-service confirms the
 * policy counts, so a test that feeds one to the consumer has to say what the
 * source answers. By default it is the happy path: {@link echoing} makes the
 * source confirm what the event states. A test about the source disagreeing
 * sets the verdict itself ({@link set}, {@link deny}) or takes it down
 * ({@link unreachable}); an explicit verdict is never overwritten by the echo.
 */
export class FakePolicySource implements InsurancePolicySource {
  readonly asked: { organizationId: string; assetId: string; policyId: string }[] = [];
  private readonly verdicts = new Map<string, PolicyVerdict>();
  private readonly explicit = new Set<string>();
  private down = false;

  /** The source confirms the policy as the event states it, unless a verdict was set. */
  echo(payload: Record<string, unknown>): void {
    const policyId = payload.policyId;
    if (typeof policyId !== 'string' || this.explicit.has(policyId)) return;
    this.verdicts.set(policyId, {
      counts: true,
      organizationId: String(payload.organizationId),
      coverage: String(payload.coverage),
      validFrom: String(payload.validFrom),
      validUntil: String(payload.validTo),
      ownershipGeneration:
        typeof payload.ownershipGeneration === 'number' ? payload.ownershipGeneration : 0,
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
    return this.verdicts.get(policyId) ?? { counts: false, reason: 'UNKNOWN_POLICY' };
  }
}

/** Makes `consumer.handle` register an `INSURANCE_RECORDED`'s own statement as the source's answer. */
export function echoing<T extends { handle: (...args: never[]) => Promise<unknown> }>(
  consumer: T,
  source: FakePolicySource,
): T {
  const handle = consumer.handle.bind(consumer) as (...args: unknown[]) => Promise<unknown>;
  (consumer as { handle: unknown }).handle = (...args: unknown[]) => {
    const envelope = args[0] as { eventName?: string; payload?: Record<string, unknown> };
    if (envelope.eventName === 'INSURANCE_RECORDED' && envelope.payload) {
      source.echo(envelope.payload);
    }
    return handle(...args);
  };
  return consumer;
}
