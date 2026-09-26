import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import {
  RastaError,
  createSystemContext,
  getContext,
  runUnscoped,
  runWithContext,
} from '@rasta/nest-common';
import { IdentityRepository, isUniqueViolation } from './identity.repository';
import { IDENTITY_EVENTS, validateIdentityPayload } from './events';
import { isMembershipLive, liveMembershipWhere } from './membership-window';
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
  isWithinProvisioningScope,
  type ProvisioningScopePolicy,
} from './provisioning-scope';
import { IDENTITY_TOPIC, SERVICE_NAME } from '../config/env';
import { KeycloakAdminClient } from '../keycloak/keycloak.client';
import { KeycloakProjector } from '../keycloak/keycloak.projector';
import { platformAttributesFor } from '../keycloak/platform-attributes';
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
    /** The one writer of the Keycloak attributes tokens are built from (ADR-060 § 5). */
    private readonly projector: KeycloakProjector,
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
    const grantedAt = new Date();

    const keycloakId = await this.keycloak.createUser({
      username: dto.username,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      // Exactly what the projector would write for the rows committed below,
      // so the account's very first token is already right.
      attributes: platformAttributesFor(
        { id: userId, activeOrganizationId: dto.organizationId },
        [
          {
            organizationId: dto.organizationId,
            roles: dto.roles,
            status: 'ACTIVE',
            validFrom: grantedAt,
            validUntil: null,
          },
        ],
        grantedAt,
      ),
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

    await this.projector.projectAfterCommit(userId);

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
      // Every membership change for one user takes the same lock first.
      await this.repository.lockUserMemberships(tx, membership.userId);

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

    // Promotion and demotion alike: before ADR-060 neither ever reached the
    // token, because roles were written to Keycloak only when the account was
    // created. A demoted administrator kept administering.
    await this.projector.projectAfterCommit(membership.userId);

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
      // Before the membership is touched: a switch to this organization either
      // commits first and is then moved off below, or waits and is refused.
      await this.repository.lockUserMemberships(tx, membership.userId);

      await tx.membership.update({
        where: { id: membershipId },
        data: {
          status: 'REVOKED',
          deletedAt: new Date(),
          updatedBy: actor,
          version: { increment: 1 },
        },
      });

      await this.moveActiveOrganizationOff(tx, membership.userId, membership.organizationId, actor);

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

    await this.projector.projectAfterCommit(membership.userId);
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

    const userId = context.userId;
    const user = await this.repository.transaction(async (tx) => {
      // Serialised with every membership change for this user, so the
      // membership checked below is still the membership when this commits
      // (Codex #114 R1-1).
      const current = await this.repository.lockUserMemberships(tx, userId);

      // Read and judged inside the lock, against the database's clock: a
      // revocation or an expiry that committed first is seen here. A caller
      // with no user row holds no membership either, and is refused the same
      // way — a `404` here would tell them something the `403` does not.
      const membership = current
        ? await this.repository.findMembership(userId, dto.organizationId, tx)
        : null;
      // Live, not merely ACTIVE: a membership past its validUntil is not one the
      // caller may act for, and this is where acting for it would begin.
      if (!current || !membership || !isMembershipLive(membership, current.now)) {
        // Marked as the one refusal this service records as audit evidence
        // (ADR-053 § 4). The mark changes nothing about the error or its `403`;
        // it only tells the exception filter that *this* decision is the one the
        // allowlist in `refusal-sites.ts` describes.
        throw markRefusal(
          RastaError.tenantMismatch(dto.organizationId, []),
          'SWITCH_ACTIVE_ORGANIZATION',
        );
      }

      // Re-selecting the organization already active changes nothing, so it
      // writes nothing and records nothing (Codex #114 R1-2).
      if (current.activeOrganizationId === dto.organizationId) {
        const unchanged = await this.repository.findUserById(userId, tx);
        if (!unchanged) throw RastaError.notFound('User', userId);
        return unchanged;
      }

      const updated = await runUnscoped(
        'a user may switch between organizations they belong to',
        () =>
          tx.user.update({
            where: { id: userId },
            data: { activeOrganizationId: dto.organizationId, updatedBy: userId },
          }),
      );

      // The audit record of the switch, in the same transaction as the write
      // (AGENTS.md S-06, A-08).
      await this.repository.enqueueEvent(tx, {
        aggregateType: 'User',
        aggregateId: userId,
        eventName: IDENTITY_EVENTS.ACTIVE_ORGANIZATION_SWITCHED,
        topic: IDENTITY_TOPIC,
        organizationId: dto.organizationId,
        payload: validateIdentityPayload(IDENTITY_EVENTS.ACTIVE_ORGANIZATION_SWITCHED, {
          userId,
          previousOrganizationId: current.activeOrganizationId,
          organizationId: dto.organizationId,
        }),
      });

      return updated;
    });

    // Not after-commit best effort: the caller asked for this switch and waits
    // on its answer. The event above is an audit record, not a retry trigger —
    // the Keycloak re-projection consumer does not act on it
    // (`REPROJECTED_EVENTS`) — so a failed write is reported, as it always was.
    await this.projector.project(user.id, 'request');

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

    // A registration outside the caller's provisioning scope must look
    // exactly like one that does not exist. Checking status or emitting a
    // scope-specific refusal before this would let the id alone tell a
    // reviewer things they have no authority over: missing (404) versus
    // exists-but-decided (409) versus exists-and-pending (the old 403 from
    // `assertMayProvisionInto`) is enough for a `UNION_ADMIN` of org A to
    // learn the state of org B's registrations without ever touching them.
    // The organization itself came from the applicant, on a `@Public`
    // endpoint, so this is also what stops a reviewer from filing their own
    // registration naming any organization and approving it — the same gap
    // `assertMayProvisionInto` closes on the two direct provisioning paths.
    if (
      !request ||
      !isWithinProvisioningScope(request.requestedOrganizationId, this.provisioningScope)
    ) {
      throw RastaError.notFound('RegistrationRequest', registrationId);
    }

    if (request.status !== 'PENDING') {
      throw RastaError.invalidStateTransition(
        'RegistrationRequest',
        request.status,
        'APPROVED',
        'Only a pending registration can be approved',
      );
    }

    const grantedRoles = dto.roles ?? request.requestedRoles;

    // Checked on `grantedRoles`, which is the set actually granted — so the
    // check covers the reviewer's own narrower choice *and* the default, where
    // the roles came from the anonymous applicant. Without it, "approve" grants
    // whatever a stranger typed into a public endpoint.
    assertMayGrantRoles(grantedRoles as readonly PlatformRole[], this.roleGrants);

    const reviewer = getContext().userId ?? 'SYSTEM';
    const membershipId = `${ID_PREFIXES.membership}_${ulid()}`;
    const grantedAt = new Date();

    const keycloakId = await this.keycloak.createUser({
      username: request.user.username,
      email: request.user.email,
      firstName: request.user.firstName,
      lastName: request.user.lastName,
      attributes: platformAttributesFor(
        { id: request.userId, activeOrganizationId: request.requestedOrganizationId },
        [
          {
            organizationId: request.requestedOrganizationId,
            roles: grantedRoles,
            status: 'ACTIVE',
            validFrom: grantedAt,
            validUntil: null,
          },
        ],
        grantedAt,
      ),
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

    // Same oracle as `approveRegistration`, and here the unchecked path was
    // worse: this function had no scope check at all, before or after the
    // status check — any `UNION_ADMIN` on the platform could reject a
    // PENDING registration destined for an organization they have no
    // authority over, not merely learn that it existed.
    if (
      !request ||
      !isWithinProvisioningScope(request.requestedOrganizationId, this.provisioningScope)
    ) {
      throw RastaError.notFound('RegistrationRequest', registrationId);
    }

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

  // -------------------------------------------------------------------------
  // Membership expiry (ADR-060 § 5)
  // -------------------------------------------------------------------------

  /**
   * Acts on one membership whose `validUntil` has passed.
   *
   * The membership stopped granting anything at `validUntil` on its own — every
   * decision reads the validity window against the clock. What does not happen
   * on its own is everything *outside* this database that still believes in
   * it: the user's Keycloak attributes, and so their next token; the active
   * organization they land in; the audit trail. This is that step:
   *
   * 1. claim the lapse (`lapse_handled_at IS NULL`), so every replica may
   *    sweep and exactly one acts;
   * 2. move the user's active organization off it, if it was the active one;
   * 3. publish `MEMBERSHIP_EXPIRED` — audit evidence, and the durable trigger
   *    for re-projection should step 4 fail;
   * 4. re-project the user after commit.
   *
   * 1–3 commit together. Runs inside the membership's own organization, like a
   * request would: a background job is not trusted more than a person is.
   *
   * Returns whether this call acted, which is `false` when another replica
   * claimed the lapse first.
   */
  async expireLapsedMembership(
    membership: { id: string; userId: string; organizationId: string; validUntil: Date | null },
    now: Date,
  ): Promise<boolean> {
    if (!membership.validUntil || membership.validUntil > now) return false;
    const validUntil = membership.validUntil;

    const acted = await runWithContext(
      createSystemContext({
        correlationId: `membership-expiry-${membership.id}`,
        organizationId: membership.organizationId,
        callerService: SERVICE_NAME,
      }),
      () =>
        this.repository.transaction(async (tx) => {
          // The same per-user serialisation as revocation and the switch.
          await this.repository.lockUserMemberships(tx, membership.userId);

          const claim = await tx.membership.updateMany({
            where: { id: membership.id, lapseHandledAt: null, deletedAt: null },
            data: { lapseHandledAt: now },
          });
          if (claim.count === 0) return false;

          await this.moveActiveOrganizationOff(
            tx,
            membership.userId,
            membership.organizationId,
            'SYSTEM',
            now,
          );

          await this.repository.enqueueEvent(tx, {
            aggregateType: 'Membership',
            aggregateId: membership.id,
            eventName: IDENTITY_EVENTS.MEMBERSHIP_EXPIRED,
            topic: IDENTITY_TOPIC,
            organizationId: membership.organizationId,
            payload: validateIdentityPayload(IDENTITY_EVENTS.MEMBERSHIP_EXPIRED, {
              membershipId: membership.id,
              userId: membership.userId,
              organizationId: membership.organizationId,
              validUntil: validUntil.toISOString(),
            }),
          });
          return true;
        }),
    );

    if (acted) await this.projector.projectAfterCommit(membership.userId);
    return acted;
  }

  /**
   * A revoked or lapsed membership cannot stay the organization the user acts for.
   *
   * Left in place, the token's `org_id` would name an organization that is no
   * longer in `org_ids` — the case ADR-060 § 4 refuses outright — and the
   * database would disagree with itself about where this user works. It moves
   * to the user's earliest remaining live membership, or is cleared when
   * there is none. Earliest rather than any: the same rows must always give the
   * same answer. In the revoking (or lapsing) transaction, so the two never
   * disagree.
   */
  private async moveActiveOrganizationOff(
    tx: ExtendedPrismaClient,
    userId: string,
    leftOrganizationId: string,
    actor: string,
    now: Date = new Date(),
  ): Promise<void> {
    const user = await this.repository.findUserById(userId, tx);
    if (!user || user.activeOrganizationId !== leftOrganizationId) return;

    const next = await runUnscoped('a user may belong to several organizations', () =>
      tx.membership.findFirst({
        where: {
          userId,
          organizationId: { not: leftOrganizationId },
          ...liveMembershipWhere(now),
        },
        orderBy: { createdAt: 'asc' },
      }),
    );

    await runUnscoped('the active organization is a property of the user, not of a tenant', () =>
      tx.user.update({
        where: { id: userId },
        data: { activeOrganizationId: next?.organizationId ?? null, updatedBy: actor },
      }),
    );
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
