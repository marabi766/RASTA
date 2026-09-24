import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, runUnscoped } from '@rasta/nest-common';
import { IdentityRepository, isUniqueViolation } from './identity.repository';
import { IDENTITY_EVENTS, validateIdentityPayload } from './events';
import {
  DEFAULT_ROLE_GRANT_POLICY,
  ROLE_GRANT_POLICY,
  assertMayGrantRoles,
  assertMayManageMembershipRoles,
  assertRolesMayBeRequested,
  grantableRoles,
  type RoleGrantPolicy,
} from './role-grants';
import {
  DEFAULT_PROVISIONING_SCOPE_POLICY,
  PROVISIONING_SCOPE_POLICY,
  assertMayProvisionInto,
  type ProvisioningScopePolicy,
} from './provisioning-scope';
import { IDENTITY_TOPIC } from '../config/env';
import { KeycloakAdminClient } from '../keycloak/keycloak.client';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { markRefusal } from '../security-events/refusal-sites';
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
  PlatformRole,
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
/**
 * Who may edit another person's profile. `SYSTEM_ADMIN` is listed for
 * clarity; `RolesGuard` already treats it as satisfying any role check, but
 * this check is made in the service, not by the guard.
 */
const PROFILE_ADMIN_ROLES: readonly string[] = ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'];

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    private readonly repository: IdentityRepository,
    private readonly keycloak: KeycloakAdminClient,
    /**
     * Which roles the caller may hand out. Injected rather than imported so a
     * deployment answers Q-60 with an environment value; the default is the
     * narrow reading of `docs/09`'s scope column, so a construction that
     * forgets it fails closed rather than open.
     */
    @Inject(ROLE_GRANT_POLICY)
    private readonly roleGrants: RoleGrantPolicy = DEFAULT_ROLE_GRANT_POLICY,
    /**
     * Which organization this caller may provision into (`docs/24` Q-61).
     * Injected for the same reason the ladder is, and defaulted to the narrow
     * reading so a construction that forgets it fails closed.
     */
    @Inject(PROVISIONING_SCOPE_POLICY)
    private readonly provisioningScope: ProvisioningScopePolicy = DEFAULT_PROVISIONING_SCOPE_POLICY,
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
      // Derived from `context.roles` — the verified token — and not from
      // `effectiveRoles` above, because `assertMayGrantRoles` measures the
      // token too. The two can disagree: a membership whose roles changed
      // after this token was minted still carries the old claims until it is
      // refreshed. Answering from the row would hand a client a picker the
      // service then refuses, which is the drift this field exists to end.
      grantableRoles: [...grantableRoles(context.roles, this.roleGrants)],
    };
  }

  async getUser(id: string): Promise<UserView> {
    // Object-level authorization: a user is visible only through a membership
    // in the requesting organization. Checking the membership rather than the
    // user is what keeps this from leaking across tenants.
    const context = getContext();
    if (id !== context.userId) {
      // Fails closed. This used to run only `if (context.organizationId)`, so a
      // token that resolved no organization skipped the check entirely and
      // `findUserById` — which is unscoped — answered for anybody on the
      // platform. That state is reachable: the guard falls back to the IdP
      // subject for an account with no platform claims (ADR-060 § Context).
      // With no organization there is nothing a non-self read can be scoped
      // to, so the answer is the one a user in another tenant gets.
      if (!context.organizationId) throw RastaError.notFound('User', id);
      const membership = await this.repository.findMembership(id, context.organizationId);
      if (!membership) throw RastaError.notFound('User', id);
    }

    const user = await this.repository.findUserById(id);
    if (!user) throw RastaError.notFound('User', id);

    return toUserView(user);
  }

  async listUsers(query: ListUsersQuery) {
    const result = await this.repository.listUsersInOrganization(query);
    const membershipByUser = new Map(result.memberships.map((m) => [m.userId, m]));

    return {
      items: result.users.map((user) => {
        const membership = membershipByUser.get(user.id);
        return {
          ...toUserView(user),
          roles: membership?.roles ?? [],
          // The membership this row *is* — the row is a membership in this
          // organization, not a user in the abstract. Without it a client that
          // lists members cannot then call `/v1/memberships/:id/roles` or
          // `/revoke` on one, which is every member-management screen. It
          // discloses nothing further: the list is already scoped to the
          // caller's tenant, and the pagination cursor is a membership id.
          membershipId: membership?.id ?? null,
        };
      }),
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
    // Both before the lookup, so a caller who may not do this learns nothing
    // about whether the username they picked is taken — and, for the tenant
    // check, nothing about the organization they named either.
    assertMayProvisionInto(dto.organizationId, this.provisioningScope);
    assertMayGrantRoles(dto.roles, this.roleGrants);

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
      // Editing somebody else's profile is administering that person, which
      // `docs/09` gives to `ORGANIZATION_ADMIN` ("مدیریت کاربران سازمان").
      // Before this, the route had no `@Roles` and the service checked only
      // that the target was in the caller's organization — so any member, an
      // `OPERATOR`, could rename a colleague or change their phone number.
      //
      // Checked before the lookup, so a caller without the role learns
      // nothing about whether the id they tried is a member.
      //
      // Imprecise until ADR-060's guard ships: roles are still realm-global,
      // so an `ORGANIZATION_ADMIN` of one organization passes this check while
      // acting for another in which they are only a member. The membership
      // check below still confines them to users of the organization they act
      // for; ADR-060 makes the role itself mean "in this organization".
      if (!context.roles.some((role) => PROFILE_ADMIN_ROLES.includes(role))) {
        throw RastaError.insufficientRole(PROFILE_ADMIN_ROLES, context.roles);
      }
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
    // First, and before either lookup. `findUserById` and `findMembership` are
    // both deliberately unscoped, so without this the three outcomes below —
    // 404, 409, 201 — told a caller whether any given user belonged to any
    // given organization, and the 201 granted the membership it was probing
    // for.
    assertMayProvisionInto(dto.organizationId, this.provisioningScope);
    assertMayGrantRoles(dto.roles, this.roleGrants);

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
    // The escalation this method carried: `dto.roles` went straight onto the
    // row, so an `ORGANIZATION_ADMIN` could name `SYSTEM_ADMIN` here — on
    // their own membership, which is in their own tenant — and hold the
    // platform. Checked before the lookup: a role the caller cannot grant is
    // refused whether or not the membership they aimed at exists.
    assertMayGrantRoles(dto.roles, this.roleGrants);

    const membership = await this.repository.findMembershipById(membershipId);
    if (!membership) throw RastaError.notFound('Membership', membershipId);

    // And the other direction: the row may already hold a role above the
    // caller's ladder, which they may not quietly replace with a lesser one.
    assertMayManageMembershipRoles(membership.roles, this.roleGrants);

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

    // Revoking is the other way to take a role off somebody, so it answers to
    // the same rule as replacing one: you may administer a membership whose
    // roles you could have granted, and no other.
    assertMayManageMembershipRoles(membership.roles, this.roleGrants);

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
      // Marked as the one refusal this service records as audit evidence
      // (ADR-053 § 4). The mark changes nothing about the error or its `403`;
      // it only tells the exception filter that *this* decision is the one the
      // allowlist in `refusal-sites.ts` describes.
      throw markRefusal(
        RastaError.tenantMismatch(dto.organizationId, []),
        'SWITCH_ACTIVE_ORGANIZATION',
      );
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
    // This endpoint is unauthenticated, so there is no ladder to measure the
    // request against — but a role nobody can ever grant is one nobody can
    // usefully ask for, and storing it would put attacker-chosen bait in front
    // of a reviewer. The grant itself is still checked at approval.
    assertRolesMayBeRequested(dto.requestedRoles);

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

    // The organization came from the applicant, on a `@Public` endpoint.
    // Without this, a reviewer could file their own registration naming any
    // organization and approve it, walking around the check on the two direct
    // provisioning paths.
    assertMayProvisionInto(request.requestedOrganizationId, this.provisioningScope);

    const grantedRoles = dto.roles ?? request.requestedRoles;

    // Checked on `grantedRoles`, which is the set actually granted — so the
    // check covers the reviewer's own narrower choice *and* the default, where
    // the roles came from the anonymous applicant. Without it, "approve" grants
    // whatever a stranger typed into a public endpoint.
    assertMayGrantRoles(grantedRoles as readonly PlatformRole[], this.roleGrants);

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
