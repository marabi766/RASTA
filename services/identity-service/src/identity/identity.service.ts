import { Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, runUnscoped } from '@rasta/nest-common';
import { IdentityRepository, isUniqueViolation } from './identity.repository';
import { IDENTITY_EVENTS, validateIdentityPayload } from './events';
import { IDENTITY_TOPIC } from '../config/env';
import { KeycloakAdminClient } from '../keycloak/keycloak.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import type {
  ApproveRegistrationDto,
  CreateMembershipDto,
  CreateUserDto,
  CurrentUserView,
  ListUsersQuery,
  MembershipView,
  RegistrationRequestView,
  RejectRegistrationDto,
  RevokeMembershipDto,
  SubmitRegistrationDto,
  SwitchOrganizationDto,
  UpdateMembershipRolesDto,
  UpdateUserDto,
  UserView,
} from './dto';

/**
 * Identity domain logic.
 *
 * Every state change follows the same shape: open a transaction, apply the
 * change, enqueue the event in that same transaction, commit. That ordering is
 * what makes it impossible for the platform to believe a role was granted
 * while no consumer was ever told (ADR-021).
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly repository: IdentityRepository,
    private readonly keycloak: KeycloakAdminClient,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getCurrentUser(): Promise<CurrentUserView> {
    const context = getContext();
    if (!context.userId) {
      throw RastaError.unauthenticated('This endpoint requires a user token');
    }

    const user = await this.repository.findUserWithMemberships(context.userId);
    if (!user) {
      // The token verified but no local record exists. That means Keycloak and
      // this service have diverged, which is an operational problem, not a
      // client one — so it is logged loudly rather than returned as a 404.
      this.logger.error(
        { userId: context.userId },
        'Authenticated subject has no local user record; Keycloak and identity have diverged',
      );
      throw RastaError.notFound('User', context.userId);
    }

    const refs = await this.repository.findOrganizationRefs(
      user.memberships.map((m) => m.organizationId),
    );
    const nameById = new Map(refs.map((ref) => [ref.id, ref.name]));

    const active = user.memberships.find((m) => m.organizationId === context.organizationId);

    return {
      ...toUserView(user),
      memberships: user.memberships.map((m) => toMembershipView(m, nameById.get(m.organizationId))),
      effectiveRoles: active?.roles ?? [],
    };
  }

  async getUser(id: string): Promise<UserView> {
    // Object-level authorization: a user is visible only through a membership
    // in the requesting organization. Checking the membership rather than the
    // user is what keeps this from leaking across tenants.
    const context = getContext();
    if (context.organizationId && id !== context.userId) {
      const membership = await this.repository.findMembership(id, context.organizationId);
      if (!membership) throw RastaError.notFound('User', id);
    }

    const user = await this.repository.findUserById(id);
    if (!user) throw RastaError.notFound('User', id);

    return toUserView(user);
  }

  async listUsers(query: ListUsersQuery) {
    const result = await this.repository.listUsersInOrganization(query);
    const rolesByUser = new Map(result.memberships.map((m) => [m.userId, m.roles]));

    return {
      items: result.users.map((user) => ({
        ...toUserView(user),
        roles: rolesByUser.get(user.id) ?? [],
      })),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  // -------------------------------------------------------------------------
  // User provisioning
  // -------------------------------------------------------------------------

  /**
   * Creates an already-approved user. Used by the platform operator; the
   * self-service path is {@link submitRegistration}.
   */
  async createUser(dto: CreateUserDto): Promise<UserView> {
    const existing = await this.repository.findUserByUsernameOrEmail(dto.username, dto.email);
    if (existing) {
      // Deliberately does not say *which* field collided. Telling an
      // unauthenticated caller that an email is registered is an account
      // enumeration oracle.
      throw RastaError.alreadyExists('User');
    }

    const userId = `${ID_PREFIXES.user}_${ulid()}`;
    const membershipId = `${ID_PREFIXES.membership}_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    const keycloakId = await this.keycloak.createUser({
      username: dto.username,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      organizationId: dto.organizationId,
      roles: dto.roles,
    });

    const user = await this.repository.transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          id: userId,
          keycloakId,
          username: dto.username,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
          status: 'ACTIVE',
          activeOrganizationId: dto.organizationId,
          createdBy: actor,
          updatedBy: actor,
        },
      });

      await this.createMembershipRow(tx, {
        membershipId,
        userId,
        organizationId: dto.organizationId,
        roles: dto.roles,
        actor,
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'User',
        aggregateId: userId,
        eventName: IDENTITY_EVENTS.USER_ACTIVATED,
        topic: IDENTITY_TOPIC,
        organizationId: dto.organizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.USER_ACTIVATED, {
          userId,
          organizationId: dto.organizationId,
          roles: dto.roles,
        }),
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Membership',
        aggregateId: membershipId,
        eventName: IDENTITY_EVENTS.MEMBERSHIP_CREATED,
        topic: IDENTITY_TOPIC,
        organizationId: dto.organizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.MEMBERSHIP_CREATED, {
          membershipId,
          userId,
          organizationId: dto.organizationId,
          roles: dto.roles,
        }),
      });

      return created;
    });

    return toUserView(user);
  }

  async updateUser(id: string, dto: UpdateUserDto): Promise<UserView> {
    const context = getContext();
    const isSelf = id === context.userId;

    if (!isSelf) {
      const membership = await this.repository.findMembership(id, context.organizationId ?? '');
      if (!membership) throw RastaError.notFound('User', id);
    }

    const existing = await this.repository.findUserById(id);
    if (!existing) throw RastaError.notFound('User', id);

    const changedFields = Object.keys(dto);
    const actor = context.userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const user = await runUnscoped('user identity is not tenant-scoped', () =>
        tx.user.update({
          where: { id },
          data: {
            ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
            ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            updatedBy: actor,
            version: { increment: 1 },
          },
        }),
      );

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'User',
        aggregateId: id,
        eventName: IDENTITY_EVENTS.USER_UPDATED,
        topic: IDENTITY_TOPIC,
        aggregateVersion: user.version,
        payload: validateIdentityPayload(IDENTITY_EVENTS.USER_UPDATED, {
          userId: id,
          changedFields,
        }),
      });

      return user;
    });

    return toUserView(updated);
  }

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  async addMembership(userId: string, dto: CreateMembershipDto): Promise<MembershipView> {
    const user = await this.repository.findUserById(userId);
    if (!user) throw RastaError.notFound('User', userId);

    const existing = await this.repository.findMembership(userId, dto.organizationId);
    if (existing) throw RastaError.alreadyExists('Membership');

    const membershipId = `${ID_PREFIXES.membership}_${ulid()}`;
    const actor = getContext().userId ?? 'SYSTEM';

    const membership = await this.repository.transaction(async (tx) => {
      const created = await this.createMembershipRow(tx, {
        membershipId,
        userId,
        organizationId: dto.organizationId,
        roles: dto.roles,
        actor,
        validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Membership',
        aggregateId: membershipId,
        eventName: IDENTITY_EVENTS.MEMBERSHIP_CREATED,
        topic: IDENTITY_TOPIC,
        organizationId: dto.organizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.MEMBERSHIP_CREATED, {
          membershipId,
          userId,
          organizationId: dto.organizationId,
          roles: dto.roles,
        }),
      });

      return created;
    });

    await this.keycloak.syncMemberships(user.keycloakId, userId, await this.orgIdsFor(userId));

    return toMembershipView(membership);
  }

  async updateMembershipRoles(
    membershipId: string,
    dto: UpdateMembershipRolesDto,
  ): Promise<MembershipView> {
    const membership = await this.repository.findMembershipById(membershipId);
    if (!membership) throw RastaError.notFound('Membership', membershipId);

    const previousRoles = membership.roles;
    const actor = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.membership.update({
        where: { id: membershipId },
        data: { roles: dto.roles, updatedBy: actor, version: { increment: 1 } },
      });

      // Two events, because a consumer usually cares about one direction. The
      // gateway in particular must invalidate its permission cache the moment
      // a role is removed, or the revoked role keeps working until TTL expiry.
      const payload = {
        membershipId,
        userId: membership.userId,
        organizationId: membership.organizationId,
        previousRoles,
        newRoles: dto.roles,
        reason: dto.reason,
      };

      const nextRoles: readonly string[] = dto.roles;
      const added = nextRoles.filter((role) => !previousRoles.includes(role));
      const removed = previousRoles.filter((role) => !nextRoles.includes(role));

      if (added.length > 0) {
        await this.repository.enqueueEvent(tx, {
          aggregateType: 'Membership',
          aggregateId: membershipId,
          eventName: IDENTITY_EVENTS.ROLE_ASSIGNED,
          topic: IDENTITY_TOPIC,
          organizationId: membership.organizationId,
          payload: validateIdentityPayload(IDENTITY_EVENTS.ROLE_ASSIGNED, payload),
        });
      }

      if (removed.length > 0) {
        await this.repository.enqueueEvent(tx, {
          aggregateType: 'Membership',
          aggregateId: membershipId,
          eventName: IDENTITY_EVENTS.ROLE_REVOKED,
          topic: IDENTITY_TOPIC,
          organizationId: membership.organizationId,
          payload: validateIdentityPayload(IDENTITY_EVENTS.ROLE_REVOKED, payload),
        });
      }

      return result;
    });

    return toMembershipView(updated);
  }

  async revokeMembership(membershipId: string, dto: RevokeMembershipDto): Promise<void> {
    const membership = await this.repository.findMembershipById(membershipId);
    if (!membership) throw RastaError.notFound('Membership', membershipId);

    const actor = getContext().userId ?? 'SYSTEM';

    await this.repository.transaction(async (tx) => {
      await tx.membership.update({
        where: { id: membershipId },
        data: {
          status: 'REVOKED',
          deletedAt: new Date(),
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'Membership',
        aggregateId: membershipId,
        eventName: IDENTITY_EVENTS.MEMBERSHIP_REVOKED,
        topic: IDENTITY_TOPIC,
        organizationId: membership.organizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.MEMBERSHIP_REVOKED, {
          membershipId,
          userId: membership.userId,
          organizationId: membership.organizationId,
          reason: dto.reason,
        }),
      });
    });

    const user = await this.repository.findUserById(membership.userId);
    await this.keycloak.syncMemberships(
      user?.keycloakId ?? null,
      membership.userId,
      await this.orgIdsFor(membership.userId),
    );
  }

  /**
   * Changes which organization the caller's subsequent requests act for.
   *
   * Verifies membership before writing. Without that check this endpoint would
   * be a tenant escape with a friendly name.
   */
  async switchActiveOrganization(dto: SwitchOrganizationDto): Promise<UserView> {
    const context = getContext();
    if (!context.userId) throw RastaError.unauthenticated('This endpoint requires a user token');

    const membership = await this.repository.findMembership(context.userId, dto.organizationId);
    if (!membership || membership.status !== 'ACTIVE') {
      throw RastaError.tenantMismatch(dto.organizationId, []);
    }

    const user = await runUnscoped('a user may switch between organizations they belong to', () =>
      this.repository.client.user.update({
        where: { id: context.userId },
        data: { activeOrganizationId: dto.organizationId, updatedBy: context.userId },
      }),
    );

    await this.keycloak.setActiveOrganization(user.keycloakId, dto.organizationId);

    return toUserView(user);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Records a request to join the platform.
   *
   * Creates the user in PENDING with no Keycloak account: the product document
   * requires operator review before activation, so nothing here grants access.
   */
  async submitRegistration(dto: SubmitRegistrationDto): Promise<{ registrationId: string }> {
    const existing = await this.repository.findUserByUsernameOrEmail(dto.username, dto.email);
    if (existing) throw RastaError.alreadyExists('User');

    const userId = `${ID_PREFIXES.user}_${ulid()}`;
    const registrationId = `REG_${ulid()}`;

    await this.repository.transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          username: dto.username,
          email: dto.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone ?? null,
          status: 'PENDING',
          createdBy: 'SELF_REGISTRATION',
          updatedBy: 'SELF_REGISTRATION',
        },
      });

      await tx.registrationRequest.create({
        data: {
          id: registrationId,
          userId,
          requestedOrganizationId: dto.requestedOrganizationId,
          requestedRoles: dto.requestedRoles,
          justification: dto.justification ?? null,
          documentRefs: dto.documentRefs,
          status: 'PENDING',
        },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'RegistrationRequest',
        aggregateId: registrationId,
        eventName: IDENTITY_EVENTS.REGISTRATION_SUBMITTED,
        topic: IDENTITY_TOPIC,
        organizationId: dto.requestedOrganizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.REGISTRATION_SUBMITTED, {
          registrationId,
          userId,
          requestedOrganizationId: dto.requestedOrganizationId,
          requestedRoles: dto.requestedRoles,
        }),
      });
    });

    return { registrationId };
  }

  async approveRegistration(
    registrationId: string,
    dto: ApproveRegistrationDto,
  ): Promise<RegistrationRequestView> {
    const request = await runUnscoped(
      'registration review is performed by the platform operator across organizations',
      () =>
        this.repository.client.registrationRequest.findFirst({
          where: { id: registrationId },
          include: { user: true },
        }),
    );

    if (!request) throw RastaError.notFound('RegistrationRequest', registrationId);
    if (request.status !== 'PENDING') {
      throw RastaError.invalidStateTransition(
        'RegistrationRequest',
        request.status,
        'APPROVED',
        'Only a pending registration can be approved',
      );
    }

    const grantedRoles = dto.roles ?? request.requestedRoles;
    const reviewer = getContext().userId ?? 'SYSTEM';
    const membershipId = `${ID_PREFIXES.membership}_${ulid()}`;

    const keycloakId = await this.keycloak.createUser({
      username: request.user.username,
      email: request.user.email,
      firstName: request.user.firstName,
      lastName: request.user.lastName,
      organizationId: request.requestedOrganizationId,
      roles: grantedRoles,
    });

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.registrationRequest.update({
        where: { id: registrationId },
        data: { status: 'APPROVED', reviewedBy: reviewer, reviewedAt: new Date() },
        include: { user: true },
      });

      await runUnscoped('activating a user is a platform-level operation', () =>
        tx.user.update({
          where: { id: request.userId },
          data: {
            status: 'ACTIVE',
            keycloakId,
            activeOrganizationId: request.requestedOrganizationId,
            updatedBy: reviewer,
            version: { increment: 1 },
          },
        }),
      );

      await this.createMembershipRow(tx, {
        membershipId,
        userId: request.userId,
        organizationId: request.requestedOrganizationId,
        roles: grantedRoles,
        actor: reviewer,
      });

      for (const event of [
        {
          name: IDENTITY_EVENTS.REGISTRATION_APPROVED,
          aggregateType: 'RegistrationRequest',
          aggregateId: registrationId,
          payload: {
            registrationId,
            userId: request.userId,
            requestedOrganizationId: request.requestedOrganizationId,
            outcome: 'APPROVED' as const,
            reviewedBy: reviewer,
            grantedRoles,
          },
        },
        {
          name: IDENTITY_EVENTS.USER_ACTIVATED,
          aggregateType: 'User',
          aggregateId: request.userId,
          payload: {
            userId: request.userId,
            organizationId: request.requestedOrganizationId,
            roles: grantedRoles,
          },
        },
        {
          name: IDENTITY_EVENTS.MEMBERSHIP_CREATED,
          aggregateType: 'Membership',
          aggregateId: membershipId,
          payload: {
            membershipId,
            userId: request.userId,
            organizationId: request.requestedOrganizationId,
            roles: grantedRoles,
          },
        },
      ]) {
        await this.repository.enqueueEvent(tx, {
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventName: event.name,
          topic: IDENTITY_TOPIC,
          organizationId: request.requestedOrganizationId,
          payload: validateIdentityPayload(event.name, event.payload),
        });
      }

      return result;
    });

    return toRegistrationView(updated);
  }

  async rejectRegistration(
    registrationId: string,
    dto: RejectRegistrationDto,
  ): Promise<RegistrationRequestView> {
    const request = await runUnscoped(
      'registration review is performed by the platform operator across organizations',
      () =>
        this.repository.client.registrationRequest.findFirst({
          where: { id: registrationId },
          include: { user: true },
        }),
    );

    if (!request) throw RastaError.notFound('RegistrationRequest', registrationId);
    if (request.status !== 'PENDING') {
      throw RastaError.invalidStateTransition('RegistrationRequest', request.status, 'REJECTED');
    }

    const reviewer = getContext().userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      const result = await tx.registrationRequest.update({
        where: { id: registrationId },
        data: {
          status: 'REJECTED',
          reviewedBy: reviewer,
          reviewedAt: new Date(),
          rejectionReason: dto.reason,
        },
        include: { user: true },
      });

      await this.repository.enqueueEvent(tx, {
        aggregateType: 'RegistrationRequest',
        aggregateId: registrationId,
        eventName: IDENTITY_EVENTS.REGISTRATION_REJECTED,
        topic: IDENTITY_TOPIC,
        organizationId: request.requestedOrganizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.REGISTRATION_REJECTED, {
          registrationId,
          userId: request.userId,
          requestedOrganizationId: request.requestedOrganizationId,
          outcome: 'REJECTED' as const,
          reviewedBy: reviewer,
          rejectionReason: dto.reason,
        }),
      });

      return result;
    });

    return toRegistrationView(updated);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createMembershipRow(
    tx: ExtendedPrismaClient,
    input: {
      membershipId: string;
      userId: string;
      organizationId: string;
      roles: string[];
      actor: string;
      validUntil?: Date | null;
    },
  ) {
    try {
      // Unscoped because provisioning legitimately creates a membership for an
      // organization other than the operator's own.
      return await runUnscoped('membership provisioning targets a specified organization', () =>
        tx.membership.create({
          data: {
            id: input.membershipId,
            userId: input.userId,
            organizationId: input.organizationId,
            roles: input.roles,
            status: 'ACTIVE',
            validUntil: input.validUntil ?? null,
            createdBy: input.actor,
            updatedBy: input.actor,
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw RastaError.alreadyExists('Membership');
      throw error;
    }
  }

  private async orgIdsFor(userId: string): Promise<string[]> {
    const memberships = await this.repository.listMembershipsForUser(userId);
    return memberships.filter((m) => m.status === 'ACTIVE').map((m) => m.organizationId);
  }
}

// ---------------------------------------------------------------------------
// View mapping
//
// Explicit rather than spread-and-delete: an accidentally exposed field is a
// disclosure, and a whitelist fails closed when the model gains a column.
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  activeOrganizationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toUserView(user: UserRow): UserView {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    status: user.status,
    activeOrganizationId: user.activeOrganizationId,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

interface MembershipRow {
  id: string;
  organizationId: string;
  roles: string[];
  status: string;
  validFrom: Date;
  validUntil: Date | null;
}

function toMembershipView(membership: MembershipRow, organizationName?: string): MembershipView {
  return {
    id: membership.id,
    organizationId: membership.organizationId,
    organizationName: organizationName ?? null,
    roles: membership.roles,
    status: membership.status,
    validFrom: membership.validFrom.toISOString(),
    validUntil: membership.validUntil?.toISOString() ?? null,
  };
}

interface RegistrationRow {
  id: string;
  userId: string;
  requestedOrganizationId: string;
  requestedRoles: string[];
  justification: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
  user: { username: string; email: string; firstName: string; lastName: string };
}

function toRegistrationView(request: RegistrationRow): RegistrationRequestView {
  return {
    id: request.id,
    userId: request.userId,
    username: request.user.username,
    email: request.user.email,
    fullName: `${request.user.firstName} ${request.user.lastName}`,
    requestedOrganizationId: request.requestedOrganizationId,
    requestedRoles: request.requestedRoles,
    justification: request.justification,
    status: request.status,
    reviewedBy: request.reviewedBy,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
    createdAt: request.createdAt.toISOString(),
  };
}
