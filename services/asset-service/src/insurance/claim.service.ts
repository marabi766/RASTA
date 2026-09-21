import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { RastaError, getContext } from '@rasta/nest-common';
import { ID_PREFIXES } from '@rasta/contracts';
import type { AssetRepository } from '../asset/asset.repository';
import type { AssetService } from '../asset/asset.service';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma';
import {
  INSURANCE_EVENTS,
  validateInsurancePayload,
  type InsuranceEventName,
} from '../asset/events';
import { INSURANCE_TOPIC } from '../config/env';
import type {
  ClaimHistoryEntryView,
  ClaimStatus,
  DecideClaimDto,
  InsuranceClaimDetailView,
  InsuranceClaimView,
  RecordClaimSettlementDto,
  ReviewClaimDto,
  SubmitClaimDto,
} from '../asset/dto';
import { assertClaimTransition } from './claim-lifecycle';
import {
  assertMayDecideClaim,
  assertWithinApprovalCeiling,
  type ClaimAuthority,
} from './claim-access';

/**
 * Insurance claims (پرونده خسارت) — the basic claim of docs/17 § 17.2:
 * "ثبت، تاریخچه وضعیت و مجوز سطح Object؛ بدون ادعای اتصال واقعی".
 *
 * This is record-and-track, and it stops exactly where ADR-046 draws the
 * line. Assessment against an insurer, and paying the claim, belong to the
 * target `insurance-service` and to `economic-service` respectively. Nothing
 * here moves money: `SETTLED` records that a settlement happened elsewhere,
 * under a reference, and the event says the same.
 *
 * Every write follows the module's pattern — one transaction holding the row,
 * the outbox event (never a direct publish, AGENTS.md A-08) and the dossier
 * line — and every read goes through the tenant-scoped client, so a claim on
 * another organization's machine does not exist as far as the caller can
 * tell.
 *
 * ## Object-level authorization
 *
 * The asset is looked up first, through the scoped client, and the policy is
 * looked up *under that asset*. A policy id that belongs to a different
 * machine — the caller's or anyone else's — is a 404, never a 422: confirming
 * that a policy exists elsewhere is exactly the disclosure docs/09 forbids.
 */
@Injectable()
export class ClaimService {
  constructor(
    private readonly repository: AssetRepository,
    private readonly assets: AssetService,
    private readonly authority: ClaimAuthority,
  ) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async listClaims(assetId: string): Promise<InsuranceClaimView[]> {
    await this.assertAssetExists(assetId);

    const rows = await this.repository.client.insuranceClaim.findMany({
      where: { assetId },
      orderBy: [{ incidentAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map(toClaimView);
  }

  async getClaim(assetId: string, claimId: string): Promise<InsuranceClaimDetailView> {
    await this.assertAssetExists(assetId);
    const claim = await this.findClaim(assetId, claimId);

    // The dossier already holds every transition; reading it back is cheaper
    // and more honest than a second history table that could drift from it.
    const lines = await this.repository.client.assetTimelineEntry.findMany({
      where: { assetId, sourceEventId: { startsWith: `${claimId}:` } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

    return { ...toClaimView(claim), history: lines.map(toHistoryEntry) };
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async submitClaim(assetId: string, dto: SubmitClaimDto): Promise<InsuranceClaimView> {
    const asset = await this.assertAssetExists(assetId);

    const policy = await this.repository.client.insurancePolicy.findFirst({
      where: { id: dto.policyId, assetId, deletedAt: null },
    });
    if (!policy) throw RastaError.notFound('InsurancePolicy', dto.policyId);

    if (policy.status === 'CANCELLED') {
      throw RastaError.businessRule('A claim cannot be filed against a cancelled policy', {
        rule: 'POLICY_CANCELLED',
        policyId: policy.id,
      });
    }

    // A policy covers incidents inside its term. Outside it, the claim is
    // either against the wrong policy or a data-entry error — and accepting it
    // would put an uncovered loss on the dossier as if it were covered.
    const incidentAt = new Date(dto.incidentAt);
    if (incidentAt < policy.validFrom || incidentAt > policy.validTo) {
      throw RastaError.businessRule('The incident falls outside the policy term', {
        rule: 'INCIDENT_OUTSIDE_POLICY_TERM',
        incidentAt: dto.incidentAt,
        validFrom: policy.validFrom.toISOString(),
        validTo: policy.validTo.toISOString(),
      });
    }

    const claimId = `${ID_PREFIXES.insuranceClaim}_${ulid()}`;
    const actor = this.actor();
    const claimedAmountMinor = dto.claimedAmountMinor ? BigInt(dto.claimedAmountMinor) : null;

    const created = await this.repository.transaction(async (tx) => {
      const row = await tx.insuranceClaim.create({
        data: {
          id: claimId,
          policyId: policy.id,
          assetId,
          organizationId: asset.organizationId,
          claimNumber: dto.claimNumber ?? null,
          description: dto.description,
          incidentAt,
          claimedAmountMinor,
          status: 'SUBMITTED',
          createdBy: actor,
          updatedBy: actor,
        },
      });

      await this.enqueue(
        tx,
        claimId,
        asset.organizationId,
        INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED,
        {
          assetId,
          organizationId: asset.organizationId,
          claimId,
          policyId: policy.id,
          incidentAt: incidentAt.toISOString(),
          claimedAmountMinor: claimedAmountMinor?.toString() ?? null,
        },
      );

      await this.appendClaimLine(tx, {
        assetId,
        organizationId: asset.organizationId,
        claimId,
        status: 'SUBMITTED',
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_OPENED,
        title: 'اعلام خسارت',
        description: dto.description,
        amountMinor: claimedAmountMinor,
        actor,
        notes: null,
        detail: {
          policyId: policy.id,
          claimNumber: dto.claimNumber ?? null,
          incidentAt: dto.incidentAt,
        },
      });

      return row;
    });

    return toClaimView(created);
  }

  async startReview(
    assetId: string,
    claimId: string,
    dto: ReviewClaimDto,
  ): Promise<InsuranceClaimView> {
    const asset = await this.assertAssetExists(assetId);
    const actor = this.actor();

    const updated = await this.repository.transaction(async (tx) => {
      const row = await this.transition(tx, assetId, claimId, 'UNDER_REVIEW', {
        updatedBy: actor,
      });

      await this.enqueue(
        tx,
        claimId,
        asset.organizationId,
        INSURANCE_EVENTS.INSURANCE_CLAIM_REVIEW_STARTED,
        {
          assetId,
          organizationId: asset.organizationId,
          claimId,
          policyId: row.policyId,
          reviewedBy: actor,
        },
      );

      await this.appendClaimLine(tx, {
        assetId,
        organizationId: asset.organizationId,
        claimId,
        status: 'UNDER_REVIEW',
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_REVIEW_STARTED,
        title: 'شروع بررسی خسارت',
        description: dto.notes,
        actor,
        notes: dto.notes ?? null,
      });

      return row;
    });

    return toClaimView(updated);
  }

  async decide(assetId: string, claimId: string, dto: DecideClaimDto): Promise<InsuranceClaimView> {
    // Authority first, before any row is read: a caller who may not decide
    // learns nothing about the claim from the shape of the refusal.
    assertMayDecideClaim(this.authority);

    const asset = await this.assertAssetExists(assetId);
    const actor = this.actor();
    const decidedAt = new Date();
    const approvedAmountMinor =
      dto.decision === 'APPROVED' && dto.approvedAmountMinor
        ? BigInt(dto.approvedAmountMinor)
        : null;

    if (dto.decision === 'APPROVED') {
      assertWithinApprovalCeiling(this.authority, approvedAmountMinor);
    }

    const updated = await this.repository.transaction(async (tx) => {
      const row = await this.transition(tx, assetId, claimId, dto.decision, {
        decidedAt,
        decidedBy: actor,
        decisionNotes: dto.notes ?? null,
        approvedAmountMinor,
        updatedBy: actor,
      });

      await this.enqueue(
        tx,
        claimId,
        asset.organizationId,
        INSURANCE_EVENTS.INSURANCE_CLAIM_DECIDED,
        {
          assetId,
          organizationId: asset.organizationId,
          claimId,
          policyId: row.policyId,
          decision: dto.decision,
          approvedAmountMinor: approvedAmountMinor?.toString() ?? null,
          decidedBy: actor,
          decidedAt: decidedAt.toISOString(),
          notes: dto.notes ?? null,
        },
      );

      await this.appendClaimLine(tx, {
        assetId,
        organizationId: asset.organizationId,
        claimId,
        status: dto.decision,
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_DECIDED,
        title: dto.decision === 'APPROVED' ? 'تأیید خسارت' : 'رد خسارت',
        description: dto.notes,
        amountMinor: approvedAmountMinor,
        actor,
        notes: dto.notes ?? null,
        occurredAt: decidedAt,
      });

      return row;
    });

    return toClaimView(updated);
  }

  async recordSettlement(
    assetId: string,
    claimId: string,
    dto: RecordClaimSettlementDto,
  ): Promise<InsuranceClaimView> {
    // Recording a settlement is a financial statement about the claim, so it
    // sits behind the same authority as the decision it follows.
    assertMayDecideClaim(this.authority);

    const asset = await this.assertAssetExists(assetId);
    const actor = this.actor();
    const settledAt = dto.settledAt ? new Date(dto.settledAt) : new Date();

    const updated = await this.repository.transaction(async (tx) => {
      const row = await this.transition(tx, assetId, claimId, 'SETTLED', {
        settledAt,
        settlementReference: dto.settlementReference ?? null,
        updatedBy: actor,
      });

      await this.enqueue(
        tx,
        claimId,
        asset.organizationId,
        INSURANCE_EVENTS.INSURANCE_CLAIM_SETTLEMENT_RECORDED,
        {
          assetId,
          organizationId: asset.organizationId,
          claimId,
          policyId: row.policyId,
          approvedAmountMinor: row.approvedAmountMinor?.toString() ?? null,
          settledAt: settledAt.toISOString(),
          settlementReference: dto.settlementReference ?? null,
          recordedBy: actor,
        },
      );

      await this.appendClaimLine(tx, {
        assetId,
        organizationId: asset.organizationId,
        claimId,
        status: 'SETTLED',
        eventName: INSURANCE_EVENTS.INSURANCE_CLAIM_SETTLEMENT_RECORDED,
        title: 'ثبت تسویه خسارت',
        description: dto.settlementReference ? `مرجع تسویه: ${dto.settlementReference}` : dto.notes,
        amountMinor: row.approvedAmountMinor,
        actor,
        notes: dto.notes ?? null,
        detail: { settlementReference: dto.settlementReference ?? null },
        occurredAt: settledAt,
      });

      return row;
    });

    return toClaimView(updated);
  }

  // =========================================================================

  /**
   * Moves the claim to `to` only if it is still in a state that allows it.
   *
   * The guard is the `status` predicate in the UPDATE, not a read followed by
   * a write: two reviewers deciding the same claim at once would otherwise
   * both read UNDER_REVIEW and both succeed, and the second decision would
   * silently overwrite the first. With the predicate, exactly one wins and
   * the other is told the claim has moved on.
   */
  private async transition(
    tx: ExtendedPrismaClient,
    assetId: string,
    claimId: string,
    to: ClaimStatus,
    data: Prisma.InsuranceClaimUpdateManyMutationInput,
  ): Promise<ClaimRow> {
    const current = await tx.insuranceClaim.findFirst({ where: { id: claimId, assetId } });
    if (!current) throw RastaError.notFound('InsuranceClaim', claimId);

    assertClaimTransition(current.status as ClaimStatus, to);

    const result = await tx.insuranceClaim.updateMany({
      where: { id: claimId, assetId, status: current.status },
      data: { ...data, status: to },
    });

    if (result.count !== 1) {
      // Lost the race. Re-read so the error names the state that actually won.
      const moved = await tx.insuranceClaim.findFirst({ where: { id: claimId, assetId } });
      throw RastaError.invalidStateTransition(
        'InsuranceClaim',
        moved?.status ?? current.status,
        to,
        'The claim was changed by another request; reload and retry',
      );
    }

    const row = await tx.insuranceClaim.findFirst({ where: { id: claimId, assetId } });
    if (!row) throw RastaError.notFound('InsuranceClaim', claimId);
    return row;
  }

  private enqueue(
    tx: ExtendedPrismaClient,
    claimId: string,
    organizationId: string,
    eventName: InsuranceEventName,
    payload: Record<string, unknown>,
  ): Promise<string> {
    return this.repository.enqueueEvent(tx, {
      aggregateType: 'InsuranceClaim',
      aggregateId: claimId,
      eventName,
      topic: INSURANCE_TOPIC,
      organizationId,
      payload: validateInsurancePayload(eventName, payload),
    });
  }

  /**
   * One dossier line per status the claim reaches.
   *
   * `sourceEventId` is `<claimId>:<status>`. The lifecycle is a DAG, so a
   * claim reaches each status at most once and the unique index makes a
   * replay of the same transition a no-op rather than a duplicate line — and
   * the prefix is what `getClaim` reads the history back by.
   */
  private appendClaimLine(
    tx: ExtendedPrismaClient,
    line: {
      assetId: string;
      organizationId: string;
      claimId: string;
      status: ClaimStatus;
      eventName: InsuranceEventName;
      title: string;
      description?: string;
      amountMinor?: bigint | null;
      actor: string;
      notes: string | null;
      detail?: Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<void> {
    return this.assets.appendTimeline(tx, {
      assetId: line.assetId,
      organizationId: line.organizationId,
      eventName: line.eventName,
      sourceEventId: `${line.claimId}:${line.status}`,
      category: 'INSURANCE',
      title: line.title,
      description: line.description,
      amountMinor: line.amountMinor ?? null,
      detail: {
        claimId: line.claimId,
        status: line.status,
        actor: line.actor,
        notes: line.notes,
        ...(line.detail ?? {}),
      },
      occurredAt: line.occurredAt ?? new Date(),
    });
  }

  private actor(): string {
    return getContext().userId ?? 'SYSTEM';
  }

  private async findClaim(assetId: string, claimId: string): Promise<ClaimRow> {
    const claim = await this.repository.client.insuranceClaim.findFirst({
      where: { id: claimId, assetId },
    });
    if (!claim) throw RastaError.notFound('InsuranceClaim', claimId);
    return claim;
  }

  private async assertAssetExists(assetId: string) {
    const asset = await this.repository.findById(assetId);
    if (!asset) throw RastaError.notFound('Asset', assetId);
    return asset;
  }
}

interface ClaimRow {
  id: string;
  assetId: string;
  policyId: string;
  claimNumber: string | null;
  description: string;
  incidentAt: Date;
  claimedAmountMinor: bigint | null;
  approvedAmountMinor: bigint | null;
  status: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionNotes: string | null;
  settledAt: Date | null;
  settlementReference: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function toClaimView(claim: ClaimRow): InsuranceClaimView {
  return {
    id: claim.id,
    assetId: claim.assetId,
    policyId: claim.policyId,
    claimNumber: claim.claimNumber,
    description: claim.description,
    incidentAt: claim.incidentAt.toISOString(),
    // Strings on the wire so large rial amounts survive JSON (ADR-022).
    claimedAmountMinor: claim.claimedAmountMinor?.toString() ?? null,
    approvedAmountMinor: claim.approvedAmountMinor?.toString() ?? null,
    status: claim.status,
    decidedAt: claim.decidedAt?.toISOString() ?? null,
    decidedBy: claim.decidedBy,
    decisionNotes: claim.decisionNotes,
    settledAt: claim.settledAt?.toISOString() ?? null,
    settlementReference: claim.settlementReference,
    submittedBy: claim.createdBy,
    createdAt: claim.createdAt.toISOString(),
    updatedAt: claim.updatedAt.toISOString(),
  };
}

function toHistoryEntry(line: { detail: unknown; occurredAt: Date }): ClaimHistoryEntryView {
  const detail = (line.detail ?? {}) as { status?: unknown; actor?: unknown; notes?: unknown };
  return {
    status: typeof detail.status === 'string' ? detail.status : 'UNKNOWN',
    occurredAt: line.occurredAt.toISOString(),
    actor: typeof detail.actor === 'string' ? detail.actor : null,
    notes: typeof detail.notes === 'string' ? detail.notes : null,
  };
}
