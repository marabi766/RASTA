import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { AssetRepository, isUniqueViolation, type CostSummaryRow } from './asset.repository';
import { ASSET_EVENTS, validateAssetPayload } from './events';
import { ASSET_TOPIC } from '../config/env';
import {
  canTransition,
  explainRefusal,
  DISPATCHABLE_STATUSES,
  type AssetStatus,
  type TransitionActor,
} from './lifecycle';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type {
  ActivateAssetDto,
  AssetDossierView,
  AssetLocationView,
  AssetView,
  AttachDocumentDto,
  ChangeStatusDto,
  CreateAssetDto,
  DecommissionDto,
  ListAssetsQuery,
  NearbyQuery,
  RecordLocationDto,
  TimelineCategory,
  TimelineEntryView,
  TimelineQuery,
  TransferAssetDto,
  UpdateAssetDto,
} from './dto';

@Injectable()
export class AssetService {
  private readonly logger = new Logger(AssetService.name);

  constructor(private readonly repository: AssetRepository) {}

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);
    return toView(asset);
  }

  async list(query: ListAssetsQuery) {
    const result = await this.repository.list(query);
    return {
      items: result.items.map(toView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  async nearby(query: NearbyQuery) {
    const organizationId = getOrganizationId();
    const rows = await this.repository.findNearby(organizationId, query);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      assetTag: row.asset_tag,
      type: row.type,
      status: row.status,
      distanceMeters: Math.round(row.distance_meters),
    }));
  }

  async timeline(id: string, query: TimelineQuery) {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const result = await this.repository.listTimeline(id, query);
    return {
      items: result.items.map(toTimelineView),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  /**
   * The electronic dossier (پرونده الکترونیکی).
   *
   * This is the endpoint the product document's fleet chapter is really about:
   * one place that answers what this machine is, whether it may be dispatched
   * today, what it has cost, and what has happened to it.
   *
   * The compliance block is the part with teeth. It is computed live from
   * dates rather than read from a cached flag, because "is this legal to send
   * out right now" must not depend on a background job having run recently.
   */
  async dossier(id: string): Promise<AssetDossierView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const [policy, inspection, costRows, transferCount, recent, organization] = await Promise.all([
      this.repository.findActivePolicy(id),
      this.repository.findLatestInspection(id),
      this.repository.costSummary(id),
      this.repository.countTransfers(id),
      this.repository.listTimeline(id, { limit: 10 } as TimelineQuery),
      this.repository.findOrganizationRef(asset.organizationId),
    ]);

    const documents = await this.repository.client.assetDocumentRef.findMany({
      where: { assetId: id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const currentLocation = await this.repository.client.assetLocation.findFirst({
      where: { assetId: id, isCurrent: true },
    });

    const blockers = this.complianceBlockers(asset.status as AssetStatus, policy, inspection);

    return {
      asset: toView(asset),
      organizationName: organization?.name ?? null,
      currentLocation: currentLocation
        ? {
            id: currentLocation.id,
            siteName: currentLocation.siteName,
            addressLine: currentLocation.addressLine,
            coordinate: await this.repository.readCoordinate(currentLocation.id),
            source: currentLocation.source,
            recordedAt: currentLocation.recordedAt.toISOString(),
          }
        : null,

      compliance: {
        operable: blockers.length === 0,
        blockers,
        activeInsurance: policy
          ? {
              id: policy.id,
              policyNumber: policy.policyNumber,
              insurerName: policy.insurerName,
              coverage: policy.coverage,
              premiumMinor: policy.premiumMinor?.toString() ?? null,
              insuredValueMinor: policy.insuredValueMinor?.toString() ?? null,
              validFrom: policy.validFrom.toISOString(),
              validTo: policy.validTo.toISOString(),
              status: policy.status,
              daysUntilExpiry: daysUntil(policy.validTo),
            }
          : null,
        latestInspection: inspection
          ? {
              id: inspection.id,
              certificateNo: inspection.certificateNo,
              centerName: inspection.centerName,
              inspectedAt: inspection.inspectedAt.toISOString(),
              validTo: inspection.validTo.toISOString(),
              result: inspection.result,
              notes: inspection.notes,
              daysUntilExpiry: daysUntil(inspection.validTo),
            }
          : null,
      },

      costs: summariseCosts(costRows),

      documents: documents.map((doc) => ({
        id: doc.id,
        documentId: doc.documentId,
        kind: doc.kind,
        title: doc.title,
        issuedAt: doc.issuedAt?.toISOString() ?? null,
        expiresAt: doc.expiresAt?.toISOString() ?? null,
      })),

      recentActivity: recent.items.map(toTimelineView),
      transferCount,
    };
  }

  /**
   * Every reason this asset cannot be dispatched right now.
   *
   * All of them, not just the first: an operator who fixes one blocker should
   * not have to re-request the dossier to discover the next.
   */
  private complianceBlockers(
    status: AssetStatus,
    policy: { validTo: Date } | null,
    inspection: { validTo: Date; result: string } | null,
  ): string[] {
    const blockers: string[] = [];

    if (!DISPATCHABLE_STATUSES.includes(status)) {
      blockers.push(`Asset status is ${status}`);
    }
    if (!policy) {
      blockers.push('No insurance policy is currently in force');
    }
    if (!inspection) {
      blockers.push('No technical inspection on record');
    } else if (inspection.result === 'FAILED') {
      blockers.push('The most recent technical inspection failed');
    } else if (inspection.validTo <= new Date()) {
      blockers.push('The technical inspection certificate has expired');
    }

    return blockers;
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(dto: CreateAssetDto): Promise<AssetView> {
    const organizationId = getOrganizationId();

    if (dto.serialNumber) {
      const existing = await this.repository.findBySerialNumber(dto.serialNumber);
      if (existing) {
        // Deliberately says nothing about who holds it. A serial number check
        // that names the other organization would leak another tenant's fleet
        // to anyone willing to guess serials.
        throw RastaError.alreadyExists('Asset');
      }
    }

    if (dto.assetTag) {
      const clash = await this.repository.findByAssetTag(organizationId, dto.assetTag);
      if (clash) throw RastaError.alreadyExists('Asset');
    }

    const id = `${ID_PREFIXES.asset}_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    const created = await this.repository.transaction(async (tx) => {
      const asset = await tx.asset.create({
        data: {
          id,
          organizationId,
          name: dto.name,
          type: dto.type,
          assetTag: dto.assetTag ?? null,
          manufacturer: dto.manufacturer ?? null,
          model: dto.model ?? null,
          serialNumber: dto.serialNumber ?? null,
          manufactureYear: dto.manufactureYear ?? null,
          specifications: dto.specifications as object,
          // Registration alone does not make an asset usable. It becomes
          // ACTIVE only once its dossier is complete, which is the check in
          // `activate`.
          status: 'REGISTERED',
          createdBy: actor,
          updatedBy: actor,
        },
      });

      if (dto.location) {
        await this.insertLocation(tx, id, organizationId, {
          ...dto.location,
          source: 'MANUAL',
        } as RecordLocationDto);
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_CREATED,
        topic: ASSET_TOPIC,
        organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_CREATED, {
          assetId: id,
          organizationId,
          name: dto.name,
          type: dto.type,
          assetTag: dto.assetTag ?? null,
          serialNumber: dto.serialNumber ?? null,
          status: 'REGISTERED',
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId,
        eventName: ASSET_EVENTS.ASSET_CREATED,
        sourceEventId: `local-${id}-created`,
        category: 'LIFECYCLE',
        title: 'ثبت دارایی',
        description: `${dto.name} در ناوگان ثبت شد`,
        occurredAt: new Date(),
      });

      return asset;
    });

    return toView(created);
  }

  async update(id: string, dto: UpdateAssetDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    if (asset.status === 'DECOMMISSIONED') {
      throw RastaError.invalidStateTransition(
        'Asset',
        asset.status,
        asset.status,
        'A decommissioned asset is a historical record and cannot be edited',
      );
    }

    if (dto.assetTag) {
      const clash = await this.repository.findByAssetTag(asset.organizationId, dto.assetTag);
      if (clash && clash.id !== id) throw RastaError.alreadyExists('Asset');
    }

    const changedFields = Object.keys(dto);
    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.assetTag !== undefined ? { assetTag: dto.assetTag } : {}),
          ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer } : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.manufactureYear !== undefined ? { manufactureYear: dto.manufactureYear } : {}),
          ...(dto.specifications !== undefined
            ? { specifications: dto.specifications as object }
            : {}),
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_UPDATED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        aggregateVersion: row.version,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_UPDATED, {
          assetId: id,
          organizationId: asset.organizationId,
          changedFields,
        }),
      });

      return row;
    });

    return toView(updated);
  }

  /**
   * Commissions the asset.
   *
   * The invariant the product document implies and this enforces: an asset is
   * not usable until its file is complete. Activating a machine with no
   * insurance would put the organization in breach the moment it left the
   * yard, so the refusal lists precisely what is missing.
   */
  async activate(id: string, dto: ActivateAssetDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    this.assertTransition(asset.status as AssetStatus, 'ACTIVE', 'USER');

    const [policy, ownershipDoc] = await Promise.all([
      this.repository.findActivePolicy(id),
      this.repository.client.assetDocumentRef.findFirst({
        where: {
          assetId: id,
          deletedAt: null,
          kind: { in: ['OWNERSHIP_TITLE', 'REGISTRATION_CARD'] },
        },
      }),
    ]);

    const missing: string[] = [];
    if (!policy) missing.push('an insurance policy currently in force');
    if (!ownershipDoc) missing.push('an ownership title or registration card');

    if (missing.length > 0) {
      throw RastaError.businessRule(
        `The asset cannot be activated without ${missing.join(' and ')}.`,
        { rule: 'INCOMPLETE_DOSSIER', assetId: id, missing },
      );
    }

    const commissionedAt = dto.commissionedAt ? new Date(dto.commissionedAt) : new Date();
    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          commissionedAt,
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_ACTIVATED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_ACTIVATED, {
          assetId: id,
          organizationId: asset.organizationId,
          commissionedAt: commissionedAt.toISOString(),
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId: asset.organizationId,
        eventName: ASSET_EVENTS.ASSET_ACTIVATED,
        sourceEventId: `local-${id}-activated-${commissionedAt.getTime()}`,
        category: 'LIFECYCLE',
        title: 'ورود به ناوگان',
        description: 'دارایی فعال و آماده بهره‌برداری شد',
        occurredAt: commissionedAt,
      });

      return row;
    });

    return toView(updated);
  }

  async changeStatus(id: string, dto: ChangeStatusDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    this.assertTransition(asset.status as AssetStatus, dto.status as AssetStatus, 'USER');

    return this.applyStatusChange(id, asset, dto.status, dto.reason);
  }

  async decommission(id: string, dto: DecommissionDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    this.assertTransition(asset.status as AssetStatus, 'DECOMMISSIONED', 'USER');

    const decommissionedAt = dto.decommissionedAt ? new Date(dto.decommissionedAt) : new Date();
    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: {
          status: 'DECOMMISSIONED',
          decommissionedAt,
          decommissionedReason: dto.reason,
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_DECOMMISSIONED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_DECOMMISSIONED, {
          assetId: id,
          organizationId: asset.organizationId,
          reason: dto.reason,
          decommissionedAt: decommissionedAt.toISOString(),
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId: asset.organizationId,
        eventName: ASSET_EVENTS.ASSET_DECOMMISSIONED,
        sourceEventId: `local-${id}-decommissioned-${decommissionedAt.getTime()}`,
        category: 'LIFECYCLE',
        title: 'اسقاط',
        description: dto.reason,
        occurredAt: decommissionedAt,
      });

      return row;
    });

    return toView(updated);
  }

  /**
   * Transfers ownership.
   *
   * The identity is untouched — same id, same history, same timeline. Only the
   * tenant column moves. That is the whole point of ADR-012: a machine that
   * changes hands is the same machine, and its maintenance record must not be
   * orphaned by the paperwork.
   */
  async transfer(id: string, dto: TransferAssetDto): Promise<AssetView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    if (asset.organizationId === dto.toOrganizationId) {
      throw RastaError.businessRule('The asset already belongs to that organization', {
        rule: 'SAME_ORGANIZATION',
      });
    }

    if (asset.status === 'DECOMMISSIONED') {
      throw RastaError.invalidStateTransition(
        'Asset',
        asset.status,
        asset.status,
        'A decommissioned asset cannot be transferred',
      );
    }

    const destination = await this.repository.findOrganizationRef(dto.toOrganizationId);
    if (!destination) {
      throw RastaError.notFound('Organization', dto.toOrganizationId);
    }
    if (destination.status !== 'ACTIVE') {
      throw RastaError.businessRule(
        'The receiving organization is not active and cannot take ownership',
        { rule: 'INACTIVE_DESTINATION', status: destination.status },
      );
    }

    const transferId = `TRF_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';
    const from = asset.organizationId;
    const transferredAt = new Date();

    // A transfer is the one operation that legitimately writes rows belonging
    // to another tenant — the transfer record, the asset and its whole history
    // all land in the receiving organization. The tenant guard refuses that by
    // default, and rightly so, which is why the crossing is declared here
    // rather than worked around.
    //
    // What makes it safe is the order: `findById` above ran *scoped*, so the
    // caller has already proven they hold this asset, and the destination has
    // been checked to exist and be active. Only then is scoping lifted, and
    // only for this transaction.
    const updated = await runUnscoped(
      `ownership transfer of ${id} from ${from} to ${dto.toOrganizationId}`,
      () =>
        this.repository.transaction(async (tx) => {
          await tx.assetTransfer.create({
            data: {
              id: transferId,
              assetId: id,
              fromOrganizationId: from,
              toOrganizationId: dto.toOrganizationId,
              // Scoped to the receiving organization, so the transfer shows up in
              // the new owner's history where it is actually useful.
              organizationId: dto.toOrganizationId,
              reason: dto.reason,
              referenceNo: dto.referenceNo ?? null,
              transferredAt,
              transferredBy: actor,
            },
          });

          const row = await tx.asset.update({
            where: { id },
            data: {
              organizationId: dto.toOrganizationId,
              // Ownership changed, so the new owner must re-commission it: their
              // insurance and their paperwork, not the previous owner's.
              status: 'REGISTERED',
              updatedBy: actor,
              version: { increment: 1 },
            },
          });

          // The whole history moves with the asset, which is what keeps the
          // dossier intact across a change of owner.
          await tx.assetTimelineEntry.updateMany({
            where: { assetId: id },
            data: { organizationId: dto.toOrganizationId },
          });
          await tx.assetLocation.updateMany({
            where: { assetId: id },
            data: { organizationId: dto.toOrganizationId },
          });
          await tx.assetDocumentRef.updateMany({
            where: { assetId: id },
            data: { organizationId: dto.toOrganizationId },
          });

          await this.repository.enqueueEvent(tx, {
            aggregateType: 'Asset',
            aggregateId: id,
            eventName: ASSET_EVENTS.ASSET_TRANSFERRED,
            topic: ASSET_TOPIC,
            organizationId: dto.toOrganizationId,
            payload: validateAssetPayload(ASSET_EVENTS.ASSET_TRANSFERRED, {
              assetId: id,
              fromOrganizationId: from,
              toOrganizationId: dto.toOrganizationId,
              reason: dto.reason,
              referenceNo: dto.referenceNo ?? null,
              transferredAt: transferredAt.toISOString(),
            }),
          });

          await this.appendTimeline(tx, {
            assetId: id,
            organizationId: dto.toOrganizationId,
            eventName: ASSET_EVENTS.ASSET_TRANSFERRED,
            sourceEventId: transferId,
            category: 'TRANSFER',
            title: 'انتقال مالکیت',
            description: dto.reason,
            detail: { fromOrganizationId: from, toOrganizationId: dto.toOrganizationId },
            occurredAt: transferredAt,
          });

          return row;
        }),
    );

    return toView(updated);
  }

  async recordLocation(id: string, dto: RecordLocationDto): Promise<AssetLocationView> {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const locationId = await this.repository.transaction(async (tx) => {
      // A unique index enforces one current location per asset, so the
      // incumbent has to be demoted before the new row lands.
      await tx.assetLocation.updateMany({
        where: { assetId: id, isCurrent: true },
        data: { isCurrent: false },
      });

      const newId = await this.insertLocation(tx, id, asset.organizationId, dto);

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_LOCATION_RECORDED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_LOCATION_RECORDED, {
          assetId: id,
          organizationId: asset.organizationId,
          locationId: newId,
          hasCoordinate: dto.coordinate !== undefined,
          source: dto.source,
        }),
      });

      return newId;
    });

    const row = await this.repository.client.assetLocation.findFirstOrThrow({
      where: { id: locationId },
    });

    return {
      id: row.id,
      siteName: row.siteName,
      addressLine: row.addressLine,
      coordinate: await this.repository.readCoordinate(row.id),
      source: row.source,
      recordedAt: row.recordedAt.toISOString(),
    };
  }

  async attachDocument(id: string, dto: AttachDocumentDto) {
    const asset = await this.repository.findById(id);
    if (!asset) throw RastaError.notFound('Asset', id);

    const refId = `ADR_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    const created = await this.repository.transaction(async (tx) => {
      const row = await tx.assetDocumentRef.create({
        data: {
          id: refId,
          assetId: id,
          organizationId: asset.organizationId,
          documentId: dto.documentId,
          kind: dto.kind,
          title: dto.title,
          issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          createdBy: actor,
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED, {
          assetId: id,
          organizationId: asset.organizationId,
          documentId: dto.documentId,
          kind: dto.kind,
          expiresAt: dto.expiresAt ?? null,
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId: asset.organizationId,
        eventName: ASSET_EVENTS.ASSET_DOCUMENT_ATTACHED,
        sourceEventId: refId,
        category: 'DOCUMENT',
        title: 'افزودن مدرک',
        description: dto.title,
        detail: { kind: dto.kind },
        occurredAt: new Date(),
      });

      return row;
    });

    return {
      id: created.id,
      documentId: created.documentId,
      kind: created.kind,
      title: created.title,
      issuedAt: created.issuedAt?.toISOString() ?? null,
      expiresAt: created.expiresAt?.toISOString() ?? null,
    };
  }

  // =========================================================================
  // Called by event consumers
  // =========================================================================

  /**
   * Applies a status change that another service decided.
   *
   * fleet-service owns assignment and maintenance-service owns repair state.
   * This service records the consequence; it does not adjudicate it, which is
   * why the actor is `EVENT` and the transition table is stricter about what
   * a user may do directly.
   */
  async applyEventStatusChange(
    assetId: string,
    newStatus: AssetStatus,
    reason: string,
  ): Promise<void> {
    const asset = await this.repository.findById(assetId);
    if (!asset) {
      // The event names an asset this service has never seen. Logged rather
      // than thrown: failing here would push a perfectly valid event into a
      // dead-letter topic over a race that resolves itself.
      this.logger.warn(`Ignoring status change for unknown asset ${assetId}`);
      return;
    }

    if (!canTransition(asset.status as AssetStatus, newStatus, 'EVENT')) {
      this.logger.warn(
        `Ignoring ${asset.status} -> ${newStatus} for ${assetId}: not a legal event transition`,
      );
      return;
    }

    await this.applyStatusChange(assetId, asset, newStatus, reason);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private assertTransition(from: AssetStatus, to: AssetStatus, actor: TransitionActor): void {
    if (canTransition(from, to, actor)) return;

    throw RastaError.invalidStateTransition('Asset', from, to, explainRefusal(from, to, actor));
  }

  private async applyStatusChange(
    id: string,
    asset: { organizationId: string; status: string },
    newStatus: AssetStatus,
    reason: string,
  ): Promise<AssetView> {
    const actor = getContext().userId ?? 'SYSTEM';
    const previousStatus = asset.status;

    const updated = await this.repository.transaction(async (tx) => {
      const row = await tx.asset.update({
        where: { id },
        data: { status: newStatus, updatedBy: actor, version: { increment: 1 } },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Asset',
        aggregateId: id,
        eventName: ASSET_EVENTS.ASSET_STATUS_CHANGED,
        topic: ASSET_TOPIC,
        organizationId: asset.organizationId,
        payload: validateAssetPayload(ASSET_EVENTS.ASSET_STATUS_CHANGED, {
          assetId: id,
          organizationId: asset.organizationId,
          previousStatus,
          newStatus,
          reason,
        }),
      });

      await this.appendTimeline(tx, {
        assetId: id,
        organizationId: asset.organizationId,
        eventName: ASSET_EVENTS.ASSET_STATUS_CHANGED,
        sourceEventId: `local-${id}-status-${Date.now()}`,
        category: 'LIFECYCLE',
        title: `تغییر وضعیت به ${newStatus}`,
        description: reason,
        detail: { previousStatus, newStatus },
        occurredAt: new Date(),
      });

      return row;
    });

    return toView(updated);
  }

  private async insertLocation(
    tx: ExtendedPrismaClient,
    assetId: string,
    organizationId: string,
    dto: RecordLocationDto,
  ): Promise<string> {
    const locationId = `ALC_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    await tx.assetLocation.create({
      data: {
        id: locationId,
        assetId,
        organizationId,
        siteName: dto.siteName ?? null,
        addressLine: dto.addressLine ?? null,
        source: dto.source ?? 'MANUAL',
        isCurrent: true,
        recordedBy: actor,
      },
    });

    if (dto.coordinate) {
      await this.repository.setLocationPoint(
        tx,
        locationId,
        dto.coordinate.latitude,
        dto.coordinate.longitude,
      );
    }

    return locationId;
  }

  /**
   * Appends a line to the dossier.
   *
   * Tolerates a duplicate rather than failing: the unique index on
   * `sourceEventId` is what makes an event replay safe, and hitting it means
   * the line is already there — which is success, not an error.
   */
  async appendTimeline(
    tx: ExtendedPrismaClient,
    entry: {
      assetId: string;
      organizationId: string;
      eventName: string;
      sourceEventId: string;
      sourceService?: string;
      category: TimelineCategory;
      title: string;
      description?: string;
      amountMinor?: bigint | null;
      detail?: Record<string, unknown>;
      occurredAt: Date;
    },
  ): Promise<void> {
    try {
      await tx.assetTimelineEntry.create({
        data: {
          id: `ATL_${ulid()}`,
          assetId: entry.assetId,
          organizationId: entry.organizationId,
          eventName: entry.eventName,
          sourceService: entry.sourceService ?? 'asset-service',
          sourceEventId: entry.sourceEventId,
          category: entry.category,
          title: entry.title,
          description: entry.description ?? null,
          amountMinor: entry.amountMinor ?? null,
          detail: (entry.detail ?? {}) as object,
          occurredAt: entry.occurredAt,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// View mapping — explicit whitelists, so a new column is never exposed by
// accident
// ---------------------------------------------------------------------------

interface AssetRow {
  id: string;
  organizationId: string;
  assetTag: string | null;
  name: string;
  type: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  manufactureYear: number | null;
  status: string;
  commissionedAt: Date | null;
  decommissionedAt: Date | null;
  specifications: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function toView(asset: AssetRow): AssetView {
  return {
    id: asset.id,
    organizationId: asset.organizationId,
    assetTag: asset.assetTag,
    name: asset.name,
    type: asset.type,
    manufacturer: asset.manufacturer,
    model: asset.model,
    serialNumber: asset.serialNumber,
    manufactureYear: asset.manufactureYear,
    status: asset.status,
    commissionedAt: asset.commissionedAt?.toISOString() ?? null,
    decommissionedAt: asset.decommissionedAt?.toISOString() ?? null,
    specifications: (asset.specifications ?? {}) as Record<string, unknown>,
    createdAt: asset.createdAt.toISOString(),
    updatedAt: asset.updatedAt.toISOString(),
  };
}

interface TimelineRow {
  id: string;
  eventName: string;
  sourceService: string;
  category: string;
  title: string;
  description: string | null;
  amountMinor: bigint | null;
  detail: unknown;
  occurredAt: Date;
}

function toTimelineView(entry: TimelineRow): TimelineEntryView {
  return {
    id: entry.id,
    eventName: entry.eventName,
    sourceService: entry.sourceService,
    category: entry.category,
    title: entry.title,
    description: entry.description,
    // Money crosses the wire as a string so large rial amounts survive JSON
    // intact (ADR-022).
    amountMinor: entry.amountMinor?.toString() ?? null,
    detail: (entry.detail ?? {}) as Record<string, unknown>,
    occurredAt: entry.occurredAt.toISOString(),
  };
}

/** Negative once the date has passed, so a client can say "expired 3 days ago". */
function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

function summariseCosts(rows: CostSummaryRow[]): AssetDossierView['costs'] {
  const byCategory = new Map(rows.map((r) => [r.category, r]));

  const maintenance = BigInt(byCategory.get('MAINTENANCE')?.total_minor ?? '0');
  const cost = BigInt(byCategory.get('COST')?.total_minor ?? '0');
  const total = rows.reduce((sum, row) => sum + BigInt(row.total_minor), 0n);
  const entryCount = rows.reduce((sum, row) => sum + row.entry_count, 0);

  return {
    totalMinor: total.toString(),
    maintenanceMinor: maintenance.toString(),
    partsAndOrdersMinor: cost.toString(),
    entryCount,
  };
}
