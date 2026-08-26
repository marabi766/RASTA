import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext } from '@rasta/nest-common';
import { OrganizationRepository, toLabel, type OrganizationRow } from './organization.repository';
import { ORGANIZATION_EVENTS, validateOrganizationPayload } from './events';
import { ORGANIZATION_TOPIC } from '../config/env';
import type { PrismaTransactionClient } from '../prisma/prisma.service';
import type {
  AddLocationDto,
  ChangeStatusDto,
  ContactView,
  CreateContactDto,
  CreateOrganizationDto,
  ListOrganizationsQuery,
  LocationView,
  MoveOrganizationDto,
  NearbyQuery,
  OrganizationDetailView,
  OrganizationView,
  PolicyView,
  SetPolicyDto,
  UpdateOrganizationDto,
} from './dto';

/** Roles that may act across the whole organization tree. */
const PLATFORM_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN'] as const;

@Injectable()
export class OrganizationService {
  private readonly logger = new Logger(OrganizationService.name);

  constructor(
    private readonly repository: OrganizationRepository,
    private readonly maxDepth: number,
  ) {}

  // =========================================================================
  // Authorization — the whole tenant boundary for this service
  //
  // Organization rows are the tenant registry, so the usual "filter by
  // organizationId" rule cannot apply: it would make the hierarchy
  // unreadable. Visibility is subtree-based instead.
  //
  //   Platform roles          the entire tree.
  //   Everyone else           their own organization and everything beneath
  //                           it. A county sees its dehyaris; a dehyari sees
  //                           itself; neither sees a sibling.
  //
  // Both checks answer NOT_FOUND rather than FORBIDDEN for anything outside
  // that subtree, so identifiers cannot be probed for existence.
  // =========================================================================

  private isPlatformOperator(): boolean {
    const { roles } = getContext();
    return PLATFORM_ROLES.some((role) => roles.includes(role));
  }

  /** Root of the caller's visible subtree, or null when they see everything. */
  private async visibleRootPath(): Promise<string | null> {
    if (this.isPlatformOperator()) return null;

    const { organizationId } = getContext();
    if (!organizationId) {
      throw RastaError.forbidden('This endpoint requires an organization context');
    }

    const path = await this.repository.getPath(organizationId);
    if (!path) {
      // The token names an organization this service has never seen. That is
      // a provisioning fault, not a client error, so it is logged rather than
      // silently treated as "sees nothing".
      this.logger.error(
        `Token carries organization ${organizationId}, which does not exist here. ` +
          'Identity and organization have diverged.',
      );
      throw RastaError.forbidden('Your organization context is not recognised');
    }
    return path;
  }

  private async assertCanRead(id: string): Promise<void> {
    if (this.isPlatformOperator()) return;

    const { organizationId } = getContext();
    if (organizationId === id) return;

    if (!organizationId || !(await this.repository.isAncestorOf(organizationId, id))) {
      throw RastaError.notFound('Organization', id);
    }
  }

  /**
   * Write access.
   *
   * Stricter than read on purpose: an organization administrator may edit
   * their own organization and its descendants, but never an ancestor. A
   * dehyari must not be able to rename the union it belongs to.
   */
  private async assertCanWrite(id: string): Promise<void> {
    if (this.isPlatformOperator()) return;

    const { organizationId } = getContext();
    if (organizationId === id) return;

    if (!organizationId || !(await this.repository.isAncestorOf(organizationId, id))) {
      throw RastaError.notFound('Organization', id);
    }
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async get(id: string): Promise<OrganizationDetailView> {
    await this.assertCanRead(id);

    const organization = await this.repository.findDetailById(id);
    if (!organization) throw RastaError.notFound('Organization', id);

    const points = await this.repository.readLocationPoints(id);
    const path = await this.repository.getPath(id);

    return {
      ...toView(organization, path),
      locations: organization.locations.map((location) =>
        toLocationView(location, points.get(location.id) ?? null),
      ),
      contacts: organization.contacts.map(toContactView),
      childCount: organization.childCount,
    };
  }

  async list(query: ListOrganizationsQuery) {
    const allowedRootPath = await this.visibleRootPath();
    const result = await this.repository.list(query, allowedRootPath);

    return {
      items: result.items.map((organization) => toView(organization, null)),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  async children(id: string): Promise<OrganizationView[]> {
    await this.assertCanRead(id);
    const rows = await this.repository.findChildren(id);
    return rows.map((row) => toView(row, null));
  }

  async ancestors(id: string): Promise<OrganizationView[]> {
    await this.assertCanRead(id);
    const rows = await this.repository.findAncestors(id);
    return rows.map(rawRowToView);
  }

  async subtree(id: string, maxDepth?: number): Promise<OrganizationView[]> {
    await this.assertCanRead(id);
    const rows = await this.repository.findSubtree(id, maxDepth);
    return rows.map(rawRowToView);
  }

  async nearby(query: NearbyQuery) {
    const rows = await this.repository.findNearby(query);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      distanceMeters: Math.round(row.distance_meters),
    }));
  }

  // =========================================================================
  // Writes
  // =========================================================================

  async create(dto: CreateOrganizationDto): Promise<OrganizationView> {
    // Only a platform operator may create a root. Otherwise any organization
    // could spawn a tree outside the hierarchy and escape subtree scoping
    // altogether.
    if (!dto.parentId && !this.isPlatformOperator()) {
      throw RastaError.forbidden('Only a platform operator may create a root organization');
    }

    let parentPath: string | null = null;
    if (dto.parentId) {
      await this.assertCanWrite(dto.parentId);

      const parent = await this.repository.findById(dto.parentId);
      if (!parent) throw RastaError.notFound('Organization', dto.parentId);

      parentPath = await this.repository.getPath(dto.parentId);
      if (parent.depth + 1 > this.maxDepth) {
        throw RastaError.businessRule(`Hierarchy may not exceed ${this.maxDepth} levels`, {
          rule: 'HIERARCHY_TOO_DEEP',
          maxDepth: this.maxDepth,
          parentDepth: parent.depth,
        });
      }
    }

    if (dto.externalCode) {
      const existing = await this.repository.findByExternalCode(dto.externalCode);
      if (existing) throw RastaError.alreadyExists('Organization');
    }

    const id = `${ID_PREFIXES.organization}_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    const created = await this.repository.transaction(async (tx) => {
      const row = await tx.organization.create({
        data: {
          id,
          name: dto.name,
          shortName: dto.shortName ?? null,
          type: dto.type,
          status: 'ACTIVE',
          parentId: dto.parentId ?? null,
          externalCode: dto.externalCode ?? null,
          metadata: dto.metadata as object,
          createdBy: actor,
          updatedBy: actor,
        },
      });

      // Prisma cannot write an `Unsupported` column, so the ltree path is set
      // immediately afterwards inside the same transaction.
      const { path, depth } = await this.repository.setPath(tx, id, parentPath);

      if (dto.location) {
        await this.insertLocation(tx, id, dto.location);
      }

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Organization',
        aggregateId: id,
        eventName: ORGANIZATION_EVENTS.ORGANIZATION_CREATED,
        topic: ORGANIZATION_TOPIC,
        organizationId: id,
        payload: validateOrganizationPayload(ORGANIZATION_EVENTS.ORGANIZATION_CREATED, {
          organizationId: id,
          name: dto.name,
          type: dto.type,
          status: 'ACTIVE',
          parentId: dto.parentId ?? null,
          path,
          depth,
        }),
      });

      return { ...row, depth, path };
    });

    return toView(created, created.path);
  }

  async update(id: string, dto: UpdateOrganizationDto): Promise<OrganizationView> {
    await this.assertCanWrite(id);

    const existing = await this.repository.findById(id);
    if (!existing) throw RastaError.notFound('Organization', id);

    if (dto.externalCode) {
      const clash = await this.repository.findByExternalCode(dto.externalCode);
      if (clash && clash.id !== id) throw RastaError.alreadyExists('Organization');
    }

    const changedFields = Object.keys(dto);
    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const row = await tx.organization.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.shortName !== undefined ? { shortName: dto.shortName } : {}),
          ...(dto.externalCode !== undefined ? { externalCode: dto.externalCode } : {}),
          ...(dto.metadata !== undefined ? { metadata: dto.metadata as object } : {}),
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Organization',
        aggregateId: id,
        eventName: ORGANIZATION_EVENTS.ORGANIZATION_UPDATED,
        topic: ORGANIZATION_TOPIC,
        organizationId: id,
        aggregateVersion: row.version,
        payload: validateOrganizationPayload(ORGANIZATION_EVENTS.ORGANIZATION_UPDATED, {
          organizationId: id,
          name: row.name,
          type: row.type,
          status: row.status,
          changedFields,
        }),
      });

      return row;
    });

    return toView(updated, await this.repository.getPath(id));
  }

  /**
   * Re-parents an organization and its whole subtree.
   *
   * The cycle check is the important part: without it, making an organization
   * a child of its own descendant produces a detached ring that no subtree
   * query can reach and no ancestor walk terminates on.
   */
  async move(id: string, dto: MoveOrganizationDto): Promise<OrganizationView> {
    // Restructuring the hierarchy changes who can see whom, so it is reserved
    // to platform operators regardless of subtree position.
    if (!this.isPlatformOperator()) {
      throw RastaError.forbidden('Only a platform operator may restructure the hierarchy');
    }

    const organization = await this.repository.findById(id);
    if (!organization) throw RastaError.notFound('Organization', id);

    const oldPath = await this.repository.getPath(id);
    if (!oldPath) throw RastaError.businessRule('Organization has no hierarchy path');

    let newParentPath: string | null = null;
    if (dto.parentId) {
      if (dto.parentId === id) {
        throw RastaError.businessRule('An organization cannot be its own parent', {
          rule: 'CYCLE_DETECTED',
        });
      }

      const parent = await this.repository.findById(dto.parentId);
      if (!parent) throw RastaError.notFound('Organization', dto.parentId);

      // The check that matters: the proposed parent must not sit inside the
      // subtree being moved.
      if (await this.repository.isAncestorOf(id, dto.parentId)) {
        throw RastaError.businessRule(
          'Cannot move an organization beneath one of its own descendants',
          { rule: 'CYCLE_DETECTED', organizationId: id, proposedParentId: dto.parentId },
        );
      }

      newParentPath = await this.repository.getPath(dto.parentId);
    }

    const newPath = newParentPath ? `${newParentPath}.${toLabel(id)}` : toLabel(id);
    const actor = getContext().userId ?? 'SYSTEM';

    const result = await this.repository.transaction(async (tx) => {
      const affectedCount = await this.repository.rewriteSubtreePath(tx, oldPath, newPath);

      const row = await tx.organization.update({
        where: { id },
        data: { parentId: dto.parentId, updatedBy: actor, version: { increment: 1 } },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Organization',
        aggregateId: id,
        eventName: ORGANIZATION_EVENTS.ORGANIZATION_MOVED,
        topic: ORGANIZATION_TOPIC,
        organizationId: id,
        payload: validateOrganizationPayload(ORGANIZATION_EVENTS.ORGANIZATION_MOVED, {
          organizationId: id,
          previousParentId: organization.parentId,
          newParentId: dto.parentId,
          previousPath: oldPath,
          newPath,
          affectedCount,
          reason: dto.reason,
        }),
      });

      return row;
    });

    return toView(result, newPath);
  }

  /**
   * Changes status, cascading down the subtree.
   *
   * Suspension has to cascade: leaving a dehyari active beneath a suspended
   * union would let it keep transacting through a parent that is meant to be
   * stopped.
   */
  async changeStatus(id: string, dto: ChangeStatusDto): Promise<OrganizationView> {
    if (!this.isPlatformOperator()) {
      throw RastaError.forbidden('Only a platform operator may change organization status');
    }

    const organization = await this.repository.findById(id);
    if (!organization) throw RastaError.notFound('Organization', id);

    if (organization.status === dto.status) {
      throw RastaError.invalidStateTransition('Organization', organization.status, dto.status);
    }
    if (organization.status === 'DEACTIVATED') {
      throw RastaError.invalidStateTransition(
        'Organization',
        'DEACTIVATED',
        dto.status,
        'Deactivation is terminal; records elsewhere still reference this organization',
      );
    }

    const cascade = dto.status === 'SUSPENDED' || dto.status === 'DEACTIVATED';
    const subtreeIds = cascade
      ? (await this.repository.findSubtree(id)).map((row) => row.id)
      : [id];

    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      await tx.organization.updateMany({
        where: { id: { in: subtreeIds }, deletedAt: null },
        data: { status: dto.status, updatedBy: actor },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Organization',
        aggregateId: id,
        eventName: ORGANIZATION_EVENTS.ORGANIZATION_STATUS_CHANGED,
        topic: ORGANIZATION_TOPIC,
        organizationId: id,
        payload: validateOrganizationPayload(ORGANIZATION_EVENTS.ORGANIZATION_STATUS_CHANGED, {
          organizationId: id,
          previousStatus: organization.status,
          newStatus: dto.status,
          reason: dto.reason,
          affectedIds: subtreeIds,
        }),
      });

      return tx.organization.findFirstOrThrow({ where: { id } });
    });

    return toView(updated, await this.repository.getPath(id));
  }

  // =========================================================================
  // Policies — configurable governance (ADR-023)
  // =========================================================================

  /**
   * Effective policies, with inheritance.
   *
   * Walks from the organization up through its ancestors, keeping the nearest
   * value for each key. That is what lets the union set a platform-wide
   * default which an individual dehyari can still override.
   */
  async effectivePolicies(id: string): Promise<PolicyView[]> {
    await this.assertCanRead(id);

    const ancestors = await this.repository.findAncestors(id);
    const chain = [...ancestors.map((row) => row.id), id];

    const rows = await this.repository.client.organizationPolicy.findMany({
      where: {
        organizationId: { in: chain },
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    // Nearest wins: iterate root-first so a closer organization overwrites.
    const byKey = new Map<string, PolicyView>();
    for (const organizationId of chain) {
      for (const row of rows.filter((r) => r.organizationId === organizationId)) {
        const isOwn = organizationId === id;
        if (!isOwn && !row.inheritable) continue;
        if (byKey.has(row.key) && byKey.get(row.key)?.inheritedFrom === null) continue;

        byKey.set(row.key, {
          id: row.id,
          key: row.key,
          value: row.value,
          inheritable: row.inheritable,
          description: row.description,
          effectiveFrom: row.effectiveFrom.toISOString(),
          effectiveTo: row.effectiveTo?.toISOString() ?? null,
          inheritedFrom: isOwn ? null : organizationId,
        });
      }
    }

    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  async setPolicy(id: string, dto: SetPolicyDto): Promise<PolicyView> {
    // Policies decide who may approve what, so setting one is a platform
    // operator action even within your own subtree.
    if (!this.isPlatformOperator()) {
      throw RastaError.forbidden('Only a platform operator may set governance policy');
    }

    const organization = await this.repository.findById(id);
    if (!organization) throw RastaError.notFound('Organization', id);

    const policyId = `POL_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();

    const created = await this.repository.transaction(async (tx) => {
      // Close the current value rather than overwriting it. A governance
      // decision taken last year must remain reconstructible.
      await tx.organizationPolicy.updateMany({
        where: { organizationId: id, key: dto.key, effectiveTo: null },
        data: { effectiveTo: effectiveFrom, updatedBy: actor },
      });

      const row = await tx.organizationPolicy.create({
        data: {
          id: policyId,
          organizationId: id,
          key: dto.key,
          value: dto.value as object,
          inheritable: dto.inheritable,
          description: dto.description,
          effectiveFrom,
          effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
          createdBy: actor,
          updatedBy: actor,
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'OrganizationPolicy',
        aggregateId: policyId,
        eventName: ORGANIZATION_EVENTS.ORGANIZATION_POLICY_CHANGED,
        topic: ORGANIZATION_TOPIC,
        organizationId: id,
        payload: validateOrganizationPayload(ORGANIZATION_EVENTS.ORGANIZATION_POLICY_CHANGED, {
          organizationId: id,
          key: dto.key,
          value: dto.value,
          inheritable: dto.inheritable,
          effectiveFrom: effectiveFrom.toISOString(),
          effectiveTo: dto.effectiveTo ?? null,
          changedBy: actor,
        }),
      });

      return row;
    });

    return {
      id: created.id,
      key: created.key,
      value: created.value,
      inheritable: created.inheritable,
      description: created.description,
      effectiveFrom: created.effectiveFrom.toISOString(),
      effectiveTo: created.effectiveTo?.toISOString() ?? null,
      inheritedFrom: null,
    };
  }

  // =========================================================================
  // Locations and contacts
  // =========================================================================

  async addLocation(id: string, dto: AddLocationDto): Promise<LocationView> {
    await this.assertCanWrite(id);

    const organization = await this.repository.findById(id);
    if (!organization) throw RastaError.notFound('Organization', id);

    const locationId = await this.repository.transaction(async (tx) => {
      const newId = await this.insertLocation(tx, id, dto);

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Organization',
        aggregateId: id,
        eventName: ORGANIZATION_EVENTS.ORGANIZATION_LOCATION_CHANGED,
        topic: ORGANIZATION_TOPIC,
        organizationId: id,
        payload: validateOrganizationPayload(ORGANIZATION_EVENTS.ORGANIZATION_LOCATION_CHANGED, {
          organizationId: id,
          locationId: newId,
          kind: dto.kind,
          hasCoordinate: dto.coordinate !== undefined,
        }),
      });

      return newId;
    });

    const row = await this.repository.client.organizationLocation.findFirstOrThrow({
      where: { id: locationId },
    });
    const points = await this.repository.readLocationPoints(id);

    return toLocationView(row, points.get(locationId) ?? null);
  }

  async addContact(id: string, dto: CreateContactDto): Promise<ContactView> {
    await this.assertCanWrite(id);

    const organization = await this.repository.findById(id);
    if (!organization) throw RastaError.notFound('Organization', id);

    const contactId = `CNT_${ulid()}`;

    const row = await this.repository.transaction(async (tx) => {
      if (dto.isPrimary) {
        // Exactly one primary per kind, enforced by demoting the incumbent.
        await tx.organizationContact.updateMany({
          where: { organizationId: id, kind: dto.kind, isPrimary: true },
          data: { isPrimary: false },
        });
      }

      return tx.organizationContact.create({
        data: {
          id: contactId,
          organizationId: id,
          kind: dto.kind,
          displayName: dto.displayName,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          isPrimary: dto.isPrimary,
        },
      });
    });

    return toContactView(row);
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async insertLocation(
    tx: PrismaTransactionClient,
    organizationId: string,
    dto: AddLocationDto,
  ): Promise<string> {
    const locationId = `LOC_${ulid()}`;

    await tx.organizationLocation.create({
      data: {
        id: locationId,
        organizationId,
        kind: dto.kind,
        addressLine: dto.addressLine ?? null,
        city: dto.city ?? null,
        county: dto.county ?? null,
        province: dto.province ?? null,
        postalCode: dto.postalCode ?? null,
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
}

// ---------------------------------------------------------------------------
// View mapping — explicit whitelists, so a new column is never exposed by
// accident
// ---------------------------------------------------------------------------

interface OrganizationLike {
  id: string;
  externalCode: string | null;
  name: string;
  shortName: string | null;
  type: string;
  status: string;
  parentId: string | null;
  depth: number;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function toView(organization: OrganizationLike, path: string | null): OrganizationView {
  return {
    id: organization.id,
    externalCode: organization.externalCode,
    name: organization.name,
    shortName: organization.shortName,
    type: organization.type,
    status: organization.status,
    parentId: organization.parentId,
    path,
    depth: organization.depth,
    metadata: (organization.metadata ?? {}) as Record<string, unknown>,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

/** Maps a snake_case row from a raw query. */
function rawRowToView(row: OrganizationRow): OrganizationView {
  return {
    id: row.id,
    externalCode: row.external_code,
    name: row.name,
    shortName: row.short_name,
    type: row.type,
    status: row.status,
    parentId: row.parent_id,
    path: null,
    depth: row.depth,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

interface LocationLike {
  id: string;
  kind: string;
  addressLine: string | null;
  city: string | null;
  county: string | null;
  province: string | null;
  postalCode: string | null;
}

function toLocationView(
  location: LocationLike,
  coordinate: { latitude: number; longitude: number } | null,
): LocationView {
  return {
    id: location.id,
    kind: location.kind,
    addressLine: location.addressLine,
    city: location.city,
    county: location.county,
    province: location.province,
    postalCode: location.postalCode,
    coordinate,
  };
}

interface ContactLike {
  id: string;
  kind: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}

function toContactView(contact: ContactLike): ContactView {
  return {
    id: contact.id,
    kind: contact.kind,
    displayName: contact.displayName,
    phone: contact.phone,
    email: contact.email,
    isPrimary: contact.isPrimary,
  };
}
