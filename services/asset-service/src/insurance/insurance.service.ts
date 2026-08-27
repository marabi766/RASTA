import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { RastaError, getContext, runUnscoped } from '@rasta/nest-common';
import { AssetRepository, isUniqueViolation } from '../asset/asset.repository';
import { AssetService } from '../asset/asset.service';
import { INSURANCE_EVENTS, validateInsurancePayload } from '../asset/events';
import { INSURANCE_TOPIC } from '../config/env';
import type {
  CreateInspectionDto,
  CreatePolicyDto,
  InspectionView,
  InsurancePolicyView,
} from '../asset/dto';

/**
 * Insurance and technical inspection.
 *
 * A module inside asset-service rather than a service of its own (docs/04
 * § 4.1). The reason is an invariant, not convenience: "an active asset must
 * carry valid insurance" has to hold immediately, and a policy expires with
 * the asset it covers. Splitting them would turn one transaction into a saga
 * for no gain.
 *
 * The seam for later extraction is kept clean — its own module, its own topic,
 * no joins into asset tables beyond ownership lookups.
 */
@Injectable()
export class InsuranceService {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly repository: AssetRepository,
    private readonly assets: AssetService,
    private readonly expiryWarningDays: number,
  ) {}

  // =========================================================================
  // Policies
  // =========================================================================

  async listPolicies(assetId: string): Promise<InsurancePolicyView[]> {
    await this.assertAssetExists(assetId);

    const rows = await this.repository.client.insurancePolicy.findMany({
      where: { assetId, deletedAt: null },
      orderBy: { validTo: 'desc' },
    });

    return rows.map(toPolicyView);
  }

  async recordPolicy(assetId: string, dto: CreatePolicyDto): Promise<InsurancePolicyView> {
    const asset = await this.assertAssetExists(assetId);

    const validFrom = new Date(dto.validFrom);
    const validTo = new Date(dto.validTo);

    // A policy that has already lapsed is almost always a data-entry error —
    // and accepting one would let an asset look compliant while it is not.
    if (validTo <= new Date()) {
      throw RastaError.businessRule(
        'This policy has already expired. Record the current policy instead.',
        { rule: 'POLICY_ALREADY_EXPIRED', validTo: dto.validTo },
      );
    }

    const policyId = `INS_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    const created = await this.repository.transaction(async (tx) => {
      let row;
      try {
        row = await tx.insurancePolicy.create({
          data: {
            id: policyId,
            assetId,
            organizationId: asset.organizationId,
            policyNumber: dto.policyNumber,
            insurerName: dto.insurerName,
            coverage: dto.coverage,
            premiumMinor: dto.premiumMinor ? BigInt(dto.premiumMinor) : null,
            insuredValueMinor: dto.insuredValueMinor ? BigInt(dto.insuredValueMinor) : null,
            validFrom,
            validTo,
            documentId: dto.documentId ?? null,
            status: 'ACTIVE',
            createdBy: actor,
            updatedBy: actor,
          },
        });
      } catch (error) {
        // Same policy number from the same insurer, twice.
        if (isUniqueViolation(error)) throw RastaError.alreadyExists('InsurancePolicy');
        throw error;
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'InsurancePolicy',
        aggregateId: policyId,
        eventName: INSURANCE_EVENTS.INSURANCE_RECORDED,
        topic: INSURANCE_TOPIC,
        organizationId: asset.organizationId,
        payload: validateInsurancePayload(INSURANCE_EVENTS.INSURANCE_RECORDED, {
          assetId,
          organizationId: asset.organizationId,
          policyId,
          insurerName: dto.insurerName,
          coverage: dto.coverage,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
        }),
      });

      await this.assets.appendTimeline(tx, {
        assetId,
        organizationId: asset.organizationId,
        eventName: INSURANCE_EVENTS.INSURANCE_RECORDED,
        sourceEventId: policyId,
        category: 'INSURANCE',
        title: 'ثبت بیمه‌نامه',
        description: `${dto.insurerName} — تا ${validTo.toISOString().slice(0, 10)}`,
        amountMinor: dto.premiumMinor ? BigInt(dto.premiumMinor) : null,
        detail: { coverage: dto.coverage, policyNumber: dto.policyNumber },
        occurredAt: validFrom,
      });

      return row;
    });

    return toPolicyView(created);
  }

  // =========================================================================
  // Inspections
  // =========================================================================

  async listInspections(assetId: string): Promise<InspectionView[]> {
    await this.assertAssetExists(assetId);

    const rows = await this.repository.client.technicalInspection.findMany({
      where: { assetId },
      orderBy: { inspectedAt: 'desc' },
    });

    return rows.map(toInspectionView);
  }

  async recordInspection(assetId: string, dto: CreateInspectionDto): Promise<InspectionView> {
    const asset = await this.assertAssetExists(assetId);

    const inspectionId = `INP_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';
    const inspectedAt = new Date(dto.inspectedAt);
    const validTo = new Date(dto.validTo);

    const created = await this.repository.transaction(async (tx) => {
      const row = await tx.technicalInspection.create({
        data: {
          id: inspectionId,
          assetId,
          organizationId: asset.organizationId,
          certificateNo: dto.certificateNo,
          centerName: dto.centerName ?? null,
          inspectedAt,
          validTo,
          result: dto.result,
          notes: dto.notes ?? null,
          documentId: dto.documentId ?? null,
          createdBy: actor,
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'TechnicalInspection',
        aggregateId: inspectionId,
        eventName: INSURANCE_EVENTS.INSPECTION_RECORDED,
        topic: INSURANCE_TOPIC,
        organizationId: asset.organizationId,
        payload: validateInsurancePayload(INSURANCE_EVENTS.INSPECTION_RECORDED, {
          assetId,
          organizationId: asset.organizationId,
          inspectionId,
          certificateNo: dto.certificateNo,
          result: dto.result,
          validTo: validTo.toISOString(),
        }),
      });

      // A failed inspection is a safety event, not an administrative one:
      // fleet-service must stop offering the asset for dispatch.
      if (dto.result === 'FAILED') {
        await this.repository.enqueueEvent(tx, {
          aggregateType: 'TechnicalInspection',
          aggregateId: inspectionId,
          eventName: INSURANCE_EVENTS.INSPECTION_FAILED,
          topic: INSURANCE_TOPIC,
          organizationId: asset.organizationId,
          payload: validateInsurancePayload(INSURANCE_EVENTS.INSPECTION_FAILED, {
            assetId,
            organizationId: asset.organizationId,
            inspectionId,
            notes: dto.notes ?? null,
          }),
        });
      }

      await this.assets.appendTimeline(tx, {
        assetId,
        organizationId: asset.organizationId,
        eventName: INSURANCE_EVENTS.INSPECTION_RECORDED,
        sourceEventId: inspectionId,
        category: 'INSPECTION',
        title: dto.result === 'FAILED' ? 'مردودی معاینه فنی' : 'معاینه فنی',
        description: dto.notes ?? `نتیجه: ${dto.result}`,
        detail: { certificateNo: dto.certificateNo, result: dto.result },
        occurredAt: inspectedAt,
      });

      return row;
    });

    return toInspectionView(created);
  }

  // =========================================================================
  // Expiry sweep
  // =========================================================================

  /**
   * Emits renewal warnings and marks lapsed policies expired.
   *
   * This is the reminder the product document asks for (ch. 5.12). Two
   * properties matter:
   *
   *  - It runs unscoped, because it belongs to no single tenant.
   *  - The warning event carries `daysRemaining`, so notification-service can
   *    tell a 30-day reminder from a 3-day one without recomputing dates.
   *
   * Re-emitting a warning on every sweep is avoided by the outbox's own
   * dedupe: a repeat carries the same aggregate and event name, and consumers
   * are idempotent. The alternative — tracking "already warned" state — buys
   * little and adds a column that can drift.
   */
  async runExpirySweep(): Promise<{ warned: number; expired: number }> {
    const [expiringPolicies, expiringInspections, lapsed] = await Promise.all([
      runUnscoped('scheduled platform-wide expiry sweep', () =>
        this.repository.findPoliciesExpiringWithin(this.expiryWarningDays),
      ),
      runUnscoped('scheduled platform-wide expiry sweep', () =>
        this.repository.findInspectionsExpiringWithin(this.expiryWarningDays),
      ),
      this.repository.expireLapsedPolicies(),
    ]);

    let warned = 0;

    await this.repository.transaction(async (tx) => {
      for (const policy of expiringPolicies) {
        await this.repository.enqueueEvent(tx, {
          aggregateType: 'InsurancePolicy',
          aggregateId: policy.id,
          eventName: INSURANCE_EVENTS.INSURANCE_EXPIRING,
          topic: INSURANCE_TOPIC,
          organizationId: policy.organizationId,
          payload: validateInsurancePayload(INSURANCE_EVENTS.INSURANCE_EXPIRING, {
            assetId: policy.assetId,
            organizationId: policy.organizationId,
            policyId: policy.id,
            insurerName: policy.insurerName,
            validTo: policy.validTo.toISOString(),
            daysRemaining: daysUntil(policy.validTo),
          }),
        });
        warned += 1;
      }

      for (const inspection of expiringInspections) {
        await this.repository.enqueueEvent(tx, {
          aggregateType: 'TechnicalInspection',
          aggregateId: inspection.id,
          eventName: INSURANCE_EVENTS.INSPECTION_EXPIRING,
          topic: INSURANCE_TOPIC,
          organizationId: inspection.organizationId,
          payload: validateInsurancePayload(INSURANCE_EVENTS.INSPECTION_EXPIRING, {
            assetId: inspection.assetId,
            organizationId: inspection.organizationId,
            inspectionId: inspection.id,
            validTo: inspection.validTo.toISOString(),
            daysRemaining: daysUntil(inspection.validTo),
          }),
        });
        warned += 1;
      }

      for (const policy of lapsed) {
        await this.repository.enqueueEvent(tx, {
          aggregateType: 'InsurancePolicy',
          aggregateId: policy.id,
          eventName: INSURANCE_EVENTS.INSURANCE_EXPIRED,
          topic: INSURANCE_TOPIC,
          organizationId: policy.organizationId,
          payload: validateInsurancePayload(INSURANCE_EVENTS.INSURANCE_EXPIRED, {
            assetId: policy.assetId,
            organizationId: policy.organizationId,
            policyId: policy.id,
            validTo: policy.validTo.toISOString(),
          }),
        });
      }
    });

    if (warned > 0 || lapsed.length > 0) {
      this.logger.log(`Expiry sweep: ${warned} warnings, ${lapsed.length} policies expired`);
    }

    return { warned, expired: lapsed.length };
  }

  // =========================================================================

  private async assertAssetExists(assetId: string) {
    const asset = await this.repository.findById(assetId);
    if (!asset) throw RastaError.notFound('Asset', assetId);
    return asset;
  }
}

interface PolicyRow {
  id: string;
  policyNumber: string;
  insurerName: string;
  coverage: string;
  premiumMinor: bigint | null;
  insuredValueMinor: bigint | null;
  validFrom: Date;
  validTo: Date;
  status: string;
}

function toPolicyView(policy: PolicyRow): InsurancePolicyView {
  return {
    id: policy.id,
    policyNumber: policy.policyNumber,
    insurerName: policy.insurerName,
    coverage: policy.coverage,
    // Strings on the wire so large rial amounts survive JSON (ADR-022).
    premiumMinor: policy.premiumMinor?.toString() ?? null,
    insuredValueMinor: policy.insuredValueMinor?.toString() ?? null,
    validFrom: policy.validFrom.toISOString(),
    validTo: policy.validTo.toISOString(),
    status: policy.status,
    daysUntilExpiry: daysUntil(policy.validTo),
  };
}

interface InspectionRow {
  id: string;
  certificateNo: string;
  centerName: string | null;
  inspectedAt: Date;
  validTo: Date;
  result: string;
  notes: string | null;
}

function toInspectionView(inspection: InspectionRow): InspectionView {
  return {
    id: inspection.id,
    certificateNo: inspection.certificateNo,
    centerName: inspection.centerName,
    inspectedAt: inspection.inspectedAt.toISOString(),
    validTo: inspection.validTo.toISOString(),
    result: inspection.result,
    notes: inspection.notes,
    daysUntilExpiry: daysUntil(inspection.validTo),
  };
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}
