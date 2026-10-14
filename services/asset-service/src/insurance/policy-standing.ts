import { Inject, Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { AssetRepository } from '../asset/asset.repository';
import {
  DEFAULT_TRANSFER_INSURANCE_POLICY,
  TRANSFER_INSURANCE_POLICY,
  countsForCurrentOwner,
  type TransferInsurancePolicy,
} from './ownership';

/**
 * Whether an insurance policy counts for the asset's current owner, and the
 * window it holds now — the source fleet-service verifies an
 * `INSURANCE_RECORDED` against before it applies one (ADR-061 § 4, #240 r6).
 *
 * ## Why this exists
 *
 * fleet-service decides dispatch from the policy windows it has consumed. An
 * event is a statement about the past: replayed from a dead-letter topic after
 * the following-coverage list was narrowed, or delivered late by a previous
 * owner after a transfer chain (A→B→A), it can say a policy counts when it no
 * longer does. Patching each replay path in the consumer never converged, so
 * the consumer asks the one service whose database knows, with the same rule
 * (`countsForCurrentOwner`, Q-66) activation, the dossier and claims use, and
 * stores only what this returns.
 *
 * ## The lock on the door
 *
 * The ADR-061 § 4 pattern, as for the snapshot: `/v1/internal/…`, which the
 * gateway routes nowhere; `@AllowService('fleet-service')` on the route and
 * {@link assertPolicyStandingCaller} here, which also refuses every user token;
 * the organization is the one signed into the internal token (ADR-035), never
 * a header.
 *
 * ## What it answers, to whom
 *
 *   - a policy that is not this asset's, or an asset that does not exist: `404`,
 *     whoever asks — checked first, before the caller's tenure is looked at;
 *   - the asset's **current owner**: whether the policy counts and, if it does,
 *     its coverage, window and the asset's current ownership generation;
 *   - **any other tenant**, a former owner included: `counts: false` with
 *     `NOT_CURRENT_OWNER` and nothing else — no organization id, no owner data
 *     (AGENTS.md A-04). The caller that thinks the asset is still its own (it
 *     has not yet consumed the transfer) retries after the transfer arrives.
 */

/** The only caller: the service that keeps a dispatch replica of the policies. */
export const POLICY_STANDING_CALLERS = ['fleet-service'] as const;

export type PolicyNotCountingReason = 'NOT_ACTIVE' | 'NOT_FOLLOWING_VEHICLE' | 'NOT_CURRENT_OWNER';

export interface CountingPolicyView {
  transferred: false;
  assetId: string;
  policyId: string;
  /** The current owner. */
  organizationId: string;
  counts: true;
  coverage: string;
  validFrom: string;
  validUntil: string;
  /** The asset's current ownership generation. */
  ownershipGeneration: number;
}

export interface NotCountingPolicyView {
  transferred: false;
  assetId: string;
  policyId: string;
  /** The current owner; absent for `NOT_CURRENT_OWNER`, which names no owner. */
  organizationId?: string;
  counts: false;
  reason: PolicyNotCountingReason;
}

export type PolicyStandingResponse = CountingPolicyView | NotCountingPolicyView;

export function assertPolicyStandingCaller(): void {
  const context = getContext();
  if (
    context.authType !== 'SERVICE' ||
    !(POLICY_STANDING_CALLERS as readonly string[]).includes(context.callerService ?? '')
  ) {
    throw RastaError.forbidden(
      'This endpoint is reserved for the service that replicates policies',
    );
  }
}

interface StandingRow {
  organization_id: string;
  asset_generation: number;
  policy_id: string | null;
  coverage: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  status: string | null;
  policy_deleted_at: Date | null;
  policy_generation: number | null;
}

@Injectable()
export class InsurancePolicyStandingService {
  constructor(
    private readonly repository: AssetRepository,
    @Inject(TRANSFER_INSURANCE_POLICY)
    private readonly rule: TransferInsurancePolicy = DEFAULT_TRANSFER_INSURANCE_POLICY,
  ) {}

  async standing(assetId: string, policyId: string): Promise<PolicyStandingResponse> {
    assertPolicyStandingCaller();
    // A token with no organization is a 403 here, before any query.
    const organizationId = getOrganizationId();

    const row = await runUnscoped(
      'a replica verifies a recorded policy by id for the organization signed into its token (ADR-061 § 4)',
      async () => {
        // One statement, so the owner, generation and policy are one snapshot.
        // The INNER join: a policy that is not this asset's is a 404 for every
        // caller, before the caller's tenure decides anything.
        const rows = await this.repository.client.$queryRaw<StandingRow[]>`
          SELECT a.organization_id, a.ownership_generation AS asset_generation,
                 p.id AS policy_id, p.coverage::text AS coverage, p.valid_from, p.valid_to,
                 p.status::text AS status, p.deleted_at AS policy_deleted_at,
                 p.ownership_generation AS policy_generation
            FROM asset a
            JOIN insurance_policy p ON p.id = ${policyId} AND p.asset_id = a.id
           WHERE a.id = ${assetId} AND a.deleted_at IS NULL`;
        return rows[0] ?? null;
      },
    );
    if (!row || !row.policy_id || !row.coverage || !row.valid_from || !row.valid_to) {
      throw RastaError.notFound('InsurancePolicy', policyId);
    }

    // Only the current owner is answered. Anyone else learns that and nothing
    // more: not who owns the asset, not what the policy holds.
    if (row.organization_id !== organizationId) {
      return {
        transferred: false,
        assetId,
        policyId,
        counts: false,
        reason: 'NOT_CURRENT_OWNER',
      };
    }

    const base = {
      transferred: false as const,
      assetId,
      policyId,
      organizationId: row.organization_id,
    };
    if (row.status !== 'ACTIVE' || row.policy_deleted_at) {
      return { ...base, counts: false, reason: 'NOT_ACTIVE' };
    }
    const policy = { coverage: row.coverage, ownershipGeneration: row.policy_generation ?? 0 };
    if (!countsForCurrentOwner(policy, row.asset_generation, this.rule)) {
      return { ...base, counts: false, reason: 'NOT_FOLLOWING_VEHICLE' };
    }
    return {
      ...base,
      counts: true,
      coverage: row.coverage,
      validFrom: row.valid_from.toISOString(),
      validUntil: row.valid_to.toISOString(),
      ownershipGeneration: row.asset_generation,
    };
  }
}
