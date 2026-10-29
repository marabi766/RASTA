import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ERROR_CODES, ID_PREFIXES } from '@rasta/contracts';
import {
  RastaError,
  assertRolesAdmitted,
  createSystemContext,
  getContext,
  runUnscoped,
  runWithContext,
} from '@rasta/nest-common';
import { IdentityRepository, isRecordNotFound, isUniqueViolation } from './identity.repository';
import { IDENTITY_EVENTS, validateIdentityPayload } from './events';
import { isMembershipLive, liveMembershipWhere } from './membership-window';
import {
  MEMBERSHIP_ADMIN_ROLES,
  PROFILE_ADMIN_ROLES,
  REGISTRATION_REVIEW_ROLES,
  liveAuthority,
} from './live-authority';
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
  assertSameProvisioning,
  hashProvisioningRequest,
  provisioningAccountNotHarmless,
  provisioningAccountUnconfirmed,
  provisioningIdempotencyKey,
  replayedUserView,
  type ProvisioningBinding,
  type ProvisioningIntent,
} from './provisioning-intent';
import {
  DEFAULT_PROVISIONING_SCOPE_POLICY,
  PROVISIONING_SCOPE_POLICY,
  assertMayProvisionInto,
  isWithinProvisioningScope,
  type ProvisioningScopePolicy,
} from './provisioning-scope';
import { IDENTITY_TOPIC, SERVICE_NAME } from '../config/env';
import { APPROVAL_TRANSACTION_TIMEOUT_MS } from '../config/operation-budgets';
import {
  KeycloakAdminClient,
  KeycloakCreateUnconfirmedError,
  type CreateKeycloakUserInput,
  type KeycloakAccount,
} from '../keycloak/keycloak.client';
import { KeycloakProjector, USER_LOCK_TRANSACTION_OPTIONS } from '../keycloak/keycloak.projector';
import {
  grantsAnything,
  intersectAttributes,
  platformAttributesFor,
  type PlatformAttributes,
} from '../keycloak/platform-attributes';
import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { markRefusal } from '../security-events/refusal-sites';
import type {
  ApproveRegistrationDto,
  CreateMembershipDto,
  CreateUserDto,
  CurrentUserView,
  ListRegistrationRequestsQuery,
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
 * The services that may read which organizations a user belongs to
 * (`GET /v1/users/:id/organizations`): construction-service (CON-002 PR 8) and
 * procurement-service (ADR-070 § 7). The controller's `@AllowService` and
 * {@link IdentityService.getMemberships} both name this list; either alone would
 * leave the other layer refusing, or granting, on its own.
 */
export const MEMBERSHIP_READ_CALLERS = ['construction-service', 'procurement-service'] as const;

/**
 * The services that may ask the one-bit question "is this user a live member of the
 * organization my token is signed for" (`GET /v1/users/:id/live-membership`):
 * fleet-service, before it registers a driver (task 095). A list of its own rather than
 * an entry in {@link MEMBERSHIP_READ_CALLERS}: that route answers every organization a
 * user belongs to, with roles, and fleet needs none of it.
 */
export const LIVE_MEMBERSHIP_CALLERS = ['fleet-service'] as const;

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

  /**
   * The organizations a user belongs to **now**, with the roles held in each, for
   * construction-service's conflict-of-interest check and its owner-side authorisation
   * (CON-002 PR 8, Q-91), and procurement-service's at an RFQ opening, evaluation, selection
   * and approval (ADR-070 § 7). Service-only: one of {@link MEMBERSHIP_READ_CALLERS} with a
   * token signed for no tenant; anyone else is refused. Live memberships only (`isMembershipLive`'s predicate),
   * judged on the **database's** clock, which is the one that stamps `validFrom`.
   *
   * With `from`: the organizations the user held a membership in at any time between `from`
   * and the database's clock as the query ran (`asOf`) — the interval the detective control
   * after an opening asks for (ADR-066 § 3). Ids only.
   */
  async getMemberships(
    userId: string,
    from?: Date,
  ): Promise<
    | { userId: string; memberships: { organizationId: string; roles: string[] }[]; asOf: string }
    | { userId: string; organizationIds: string[]; asOf: string }
  > {
    const context = getContext();
    if (
      context.authType !== 'SERVICE' ||
      !MEMBERSHIP_READ_CALLERS.some((caller) => caller === context.callerService) ||
      context.organizationId !== undefined
    ) {
      throw RastaError.forbidden(
        'Only construction-service or procurement-service may read which organizations a user belongs to',
      );
    }
    if (from) {
      const since = await this.repository.findOrganizationIdsSince(userId, from);
      return { userId, organizationIds: since.organizationIds, asOf: since.asOf.toISOString() };
    }
    const live = await this.repository.findLiveMemberships(userId);
    return { userId, memberships: live.memberships, asOf: live.asOf.toISOString() };
  }

  /**
   * Whether `userId` is a live member of the organization the caller's token is signed
   * for, and when (the database's clock): fleet-service's check before it registers a
   * driver (task 095). Service-only: one of {@link LIVE_MEMBERSHIP_CALLERS} with a token
   * signed **for a tenant** (ADR-035) — the organization is the signed claim, never a
   * parameter, so a caller can ask only about the organization it is acting for.
   *
   * One bit and nothing else: no roles, no other organization, no name. A user who does
   * not exist, a member of another organization and a lapsed, revoked or suspended member
   * all get the same `live: false`, so the answer does not say whether the user exists.
   */
  async getLiveMembership(
    userId: string,
  ): Promise<{ userId: string; organizationId: string; live: boolean; asOf: string }> {
    const context = getContext();
    const organizationId = context.organizationId;
    if (
      context.authType !== 'SERVICE' ||
      !LIVE_MEMBERSHIP_CALLERS.some((caller) => caller === context.callerService) ||
      organizationId === undefined
    ) {
      throw RastaError.forbidden(
        'Only fleet-service, acting for an organization, may ask whether a user is its member',
      );
    }
    const answer = await this.repository.findLiveMembershipInScope(userId);
    return { userId, organizationId, live: answer.live, asOf: answer.asOf.toISOString() };
  }

  async getUser(id: string): Promise<UserView> {
    // Object-level authorization: a user is visible only through a membership
    // in the requesting organization. Checking the membership rather than the
    // user is what keeps this from leaking across tenants.
    //
    // Fails closed with no acting organization. This used to run only
    // `if (context.organizationId)`, so a token that resolved no organization
    // skipped the check entirely and `findUserById` — which is unscoped —
    // answered for anybody on the platform. That state is reachable: the guard
    // falls back to the IdP subject for an account with no platform claims
    // (ADR-060 § Context). And only a membership live now proves access (task
    // 117, F3): one that expired, is suspended or has not begun used to be
    // enough to read the person's email and phone long after they left.
    //
    // The predicate is `mayReadUser`, which a provisioning's replay applies
    // too (task 130, R4).
    if (!(await this.mayReadUser(id, this.repository.client))) {
      throw RastaError.notFound('User', id);
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
   *
   * Requires an `Idempotency-Key` (task 117, F6): the request makes an
   * identity-provider account before its transaction commits, so it is
   * recorded first as an intent (`provisioning-intent.ts`) carrying the user id
   * the account is made with. The same request again — same actor, key,
   * acting organization and body — creates under that id, adopts the account
   * an earlier attempt made (its `rasta_user_id` names exactly this user), or,
   * once the user committed, replays the answer. Any other account under the
   * username is somebody else's and is refused, 409, as it always was.
   */
  async createUser(dto: CreateUserDto, idempotencyKey: unknown): Promise<UserView> {
    // Both before the lookup, so a caller who may not do this learns nothing
    // about whether the username they picked is taken — and, for the tenant
    // check, nothing about the organization they named either. On the token:
    // the early refusal. The decisions that commit are made on the caller's
    // live authority under the locks below (task 117, F1).
    assertMayProvisionInto(dto.organizationId, this.provisioningScope);
    assertMayGrantRoles(dto.roles, this.roleGrants);
    const key = provisioningIdempotencyKey(idempotencyKey);

    const context = getContext();
    const actor = context.userId ?? 'SYSTEM';
    const binding: ProvisioningBinding = {
      actorId: actor,
      idempotencyKey: key,
      actingOrganizationId: context.organizationId ?? null,
      requestHash: hashProvisioningRequest(dto),
    };
    const authorizeLive = async (tx: ExtendedPrismaClient) => {
      const { authority } = await this.authorizeUnderLock(tx, [], MEMBERSHIP_ADMIN_ROLES);
      assertMayProvisionInto(dto.organizationId, this.provisioningScope, authority);
      assertMayGrantRoles(dto.roles, this.roleGrants, authority);
    };

    // 1. The intent, committed before Keycloak hears of the user. Authorized
    //    first, like everything after it, so no caller who may not make the
    //    request leaves a row behind.
    await this.repository.transaction(async (tx) => {
      const claimed = await this.repository.claimProvisioningIntent(tx, {
        ...binding,
        userId: `${ID_PREFIXES.user}_${ulid()}`,
        membershipId: `${ID_PREFIXES.membership}_${ulid()}`,
      });
      assertSameProvisioning(claimed, binding);
      await authorizeLive(tx);
    }, USER_LOCK_TRANSACTION_OPTIONS);

    // 2. Reconciled under the intent's lock, before any refusal or Keycloak
    //    call: finished → replayed; the username or email held → 409.
    const reconciled = await this.repository.transaction(
      (tx) => this.reconcileProvisioning(tx, binding, dto, authorizeLive),
      USER_LOCK_TRANSACTION_OPTIONS,
    );
    if ('replay' in reconciled) return reconciled.replay;
    const { userId, membershipId } = reconciled.intent;

    // Disabled, and carrying nothing but its provenance (D-069 addendum D):
    // no user row exists yet for a lock to cover, so until the row below has
    // committed the account must be harmless whatever happens next — a lost
    // answer, a crash, a transaction that rolls back. Its grants and its
    // enable are written after commit by the projector, each write fenced,
    // like every other write of the account. Made with the intent's user id,
    // so an account left behind by a failed attempt is this request's own.
    const created = await this.createAccount({
      username: dto.username,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      userId,
    });

    const user = await this.repository.transaction(async (tx) => {
      // 3. Reconciled again under the intent's lock: a concurrent retry of the
      //    same key waits here, then finds the answer this one committed.
      const again = await this.reconcileProvisioning(tx, binding, dto, authorizeLive);
      if ('replay' in again) return again.replay;

      const keycloakId =
        created.outcome === 'created'
          ? created.keycloakId
          : await this.adoptProvisionedAccount(dto.username, userId);

      let row;
      try {
        row = await runUnscoped('user identity is not tenant-scoped', () =>
          tx.user.create({
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
              // The projector writes the grants, enables the account and clears
              // this, once (`activateOnce`; an operator's user has no request).
              accountActivationPending: keycloakId !== null,
              createdBy: actor,
              updatedBy: actor,
            },
          }),
        );
      } catch (error) {
        // Taken meanwhile — by a registration, or another provisioning.
        if (isUniqueViolation(error)) throw RastaError.alreadyExists('User');
        throw error;
      }

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

      const view = toUserView(row);
      await this.repository.completeProvisioningIntent(tx, actor, key, view);
      return view;
      // It may read Keycloak under the intent's lock (adoption).
    }, APPROVAL_TRANSACTION_OPTIONS);

    // The grants, then the account enabled — only now that the user has
    // committed. Never throws: USER_ACTIVATED and MEMBERSHIP_CREATED, committed
    // above, bring the projection back round if this fails, and until it
    // lands the account stays disabled. A replay projects again, harmlessly:
    // a projection rebuilds the committed state.
    await this.projector.projectAfterCommit(userId);

    return user;
  }

  /**
   * One provisioning, reconciled under its intent's lock (task 130, PR #483
   * r1 R3) — the step every decision after the intent's first commit goes
   * through, before any refusal and before any further provisioning work:
   *
   * 1. the intent, locked `FOR UPDATE`, and bound to this request;
   * 2. **finished** — a concurrent or earlier send of this very request
   *    committed the user — the stored answer, through the one replay
   *    boundary ({@link replayProvisioning});
   * 3. otherwise the caller's live authority, then whether anybody holds the
   *    username or the email: 409, without saying which. The user row of this
   *    intent commits in the same transaction as its completion, so once (2)
   *    has found it open, whoever holds the name is somebody else.
   *
   * Under the lock, so the order is decided: the r1 lookup ran after the
   * first transaction and before this lock, and a retry that read the intent
   * open, then lost the race to the send that finished it, found that send's
   * user and answered 409 instead of the answer.
   */
  private async reconcileProvisioning(
    tx: ExtendedPrismaClient,
    binding: ProvisioningBinding,
    dto: CreateUserDto,
    authorizeLive: (tx: ExtendedPrismaClient) => Promise<void>,
  ): Promise<{ replay: UserView } | { intent: ProvisioningIntent }> {
    const intent = await this.repository.lockProvisioningIntent(
      tx,
      binding.actorId,
      binding.idempotencyKey,
    );
    if (!intent) throw new Error('the provisioning intent is missing');
    assertSameProvisioning(intent, binding);
    if (intent.completedAt) {
      return { replay: await this.replayProvisioning(tx, intent, binding, authorizeLive) };
    }

    await authorizeLive(tx);
    if (await this.repository.findUserByUsernameOrEmail(dto.username, dto.email, tx)) {
      // Deliberately does not say *which* field collided.
      throw RastaError.alreadyExists('User');
    }
    return { intent };
  }

  /**
   * The one replay boundary of `POST /v1/users` (task 130, PR #483 r1 R4;
   * pre-review checklist B4). A finished provisioning's stored answer is
   * returned only when, now:
   *
   * - the request is the intent's — same actor, key, acting organization and
   *   body (`assertSameProvisioning`);
   * - the caller still holds the live authority to make it (`authorizeLive`,
   *   the provisioning's own decision);
   * - the caller may **read** the user it made, by the predicate
   *   `GET /v1/users/:id` applies ({@link mayReadUser}): a membership live now
   *   in the organization the caller acts for.
   *
   * Otherwise the generic conflict a reused key gets — `409
   * IDEMPOTENCY_KEY_REUSED`, nothing stored in it: a person whose membership
   * was revoked or has expired since is no more readable through a replay
   * than through `GET`.
   */
  private async replayProvisioning(
    tx: ExtendedPrismaClient,
    intent: ProvisioningIntent,
    binding: ProvisioningBinding,
    authorizeLive: (tx: ExtendedPrismaClient) => Promise<void>,
  ): Promise<UserView> {
    assertSameProvisioning(intent, binding);
    await authorizeLive(tx);
    if (!(await this.mayReadUser(intent.userId, tx))) throw RastaError.idempotencyKeyReused();
    return replayedUserView(intent.responseBody);
  }

  /**
   * Whether the caller may read `userId` now — the predicate of
   * `GET /v1/users/:id` and of a provisioning's replay, in one place. Oneself;
   * otherwise a user, not removed, with a membership live now — on the
   * database's clock — in the organization the caller acts for (task 117,
   * F3). A membership that ended, expired, is suspended or has not begun is
   * history and proves nothing. No acting organization: nothing a non-self
   * read can be scoped to, so no.
   */
  private async mayReadUser(userId: string, db: ExtendedPrismaClient): Promise<boolean> {
    const context = getContext();
    if (userId !== context.userId) {
      if (!context.organizationId) return false;
      const now = await this.repository.databaseNow(db);
      if (!(await this.repository.findLiveMembership(userId, context.organizationId, now, db))) {
        return false;
      }
    }
    return (await this.repository.findUserById(userId, db)) !== null;
  }

  /**
   * The account an earlier attempt of this provisioning made, when Keycloak
   * answered this one's create with 409 or without an id: adopted only when
   * its `rasta_user_id` names exactly this request's user (`findOwnAccount`,
   * the rule approval applies) and it is still as every create leaves it —
   * disabled and granting nothing. Nothing on the platform writes an account
   * no user row names, so one that is not was changed in Keycloak directly,
   * and is left to an operator rather than adopted.
   */
  private async adoptProvisionedAccount(username: string, userId: string): Promise<string> {
    const found = await this.findOwnAccount(username, userId);
    if (found === 'missing') throw provisioningAccountUnconfirmed();
    if (found === 'foreign') throw RastaError.alreadyExists('User');
    if (found.enabled || grantsAnything(found.attributes)) throw provisioningAccountNotHarmless();
    this.logger.warn(
      { userId, keycloakId: found.id },
      'Provisioning adopted the Keycloak account an earlier attempt at it created',
    );
    return found.id;
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
      //
      // The token's roles are the early refusal only. The decision that
      // commits is made below, in the write's transaction (task 117, F1/F3).
      // The platform's one role predicate, as everywhere (task 130).
      assertRolesAdmitted(context.roles, { required: PROFILE_ADMIN_ROLES });
    }

    const changedFields = Object.keys(dto);
    const actor = context.userId ?? 'SYSTEM';

    const updated = await this.repository.transaction(async (tx) => {
      if (!isSelf) {
        // Decided on what holds now: the caller's live authority, and the
        // person's live membership in the organization the caller acts for —
        // both read under the locks, on the database's clock. A former member
        // is not one of this organization's users, whatever their old row says.
        const { now } = await this.authorizeUnderLock(tx, [id], PROFILE_ADMIN_ROLES);
        const membership = context.organizationId
          ? await this.repository.findLiveMembership(id, context.organizationId, now, tx)
          : null;
        if (!membership) throw RastaError.notFound('User', id);
      }
      const existing = await this.repository.findUserById(id, tx);
      if (!existing) throw RastaError.notFound('User', id);

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
    }, USER_LOCK_TRANSACTION_OPTIONS);

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
      // The user's lock, like every other membership change of theirs (task
      // 117): a creation and a role change of the same user now run one after
      // the other. Then the caller's live authority, and every check above
      // again on what holds under the lock.
      const { authority, locked } = await this.authorizeUnderLock(
        tx,
        [userId],
        MEMBERSHIP_ADMIN_ROLES,
      );
      assertMayProvisionInto(dto.organizationId, this.provisioningScope, authority);
      assertMayGrantRoles(dto.roles, this.roleGrants, authority);
      if (!locked.get(userId)) throw RastaError.notFound('User', userId);
      if (await this.repository.findMembership(userId, dto.organizationId, tx)) {
        throw RastaError.alreadyExists('Membership');
      }

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
    }, USER_LOCK_TRANSACTION_OPTIONS);

    await this.projector.projectAfterCommit(userId);

    return toMembershipView(membership);
  }

  /**
   * Replaces the roles a membership holds.
   *
   * A role removed is a narrowing change (ADR-060, write-ahead addendum,
   * D-064): Keycloak is written **before** commit with what the rows granted
   * before and after the change, intersected, and the events are enqueued
   * after that write, so their `occurredAt` — the gateway's cutoff — is later
   * than every token minted with the removed role. When Keycloak cannot be
   * written the change is refused, 503 `KEYCLOAK_UNAVAILABLE`, and nothing
   * commits. A change that only adds roles commits first and is projected
   * after, as before. A mixed change does both: the roles it keeps are
   * written ahead, the full new set after commit.
   *
   * Decided under the user lock, on the membership as read under it — its
   * roles, and the caller's right to manage them, read from the caller's live
   * membership (`live-authority.ts`) — never on the read before the lock or
   * on the token, which only pick the user to lock and refuse early. Sending the
   * same roles again (an administrator who never saw the answer, or behind a
   * gateway timeout) answers the same and emits nothing: nothing was added or
   * removed.
   */
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

    // Tenant-scoped: another organization's membership is a 404 here, before
    // any lock is taken or Keycloak is called.
    const seen = await this.repository.findMembershipById(membershipId);
    if (!seen) throw RastaError.notFound('Membership', membershipId);

    // And the other direction: the row may already hold a role above the
    // caller's ladder, which they may not quietly replace with a lesser one.
    // Refused early here, and decided again under the lock.
    assertMayManageMembershipRoles(seen.roles, this.roleGrants);

    const userId = seen.userId;
    const actor = getContext().userId ?? 'SYSTEM';
    const writeAhead = this.projector.narrowing(userId);

    const updated = await this.repository
      .transaction(async (tx) => {
        // Every Keycloak writer and every membership change for one user
        // takes the same lock before it reads a membership (`KeycloakProjector`,
        // D-064) — here with the caller's own row beside it, in id order
        // (`lockUsersInOrder`). Then the caller's authority as the database
        // holds it now, never the token's (task 117, F1): a demoted
        // administrator's old token cannot grant their role back. `now` is the
        // database's clock, read after the locks (#402 r1 F3).
        const { now, authority } = await this.authorizeUnderLock(
          tx,
          [userId],
          MEMBERSHIP_ADMIN_ROLES,
        );

        // What is decided on is what is changed: read again under the lock.
        const membership = await this.repository.findMembershipById(membershipId, tx);
        if (!membership) throw RastaError.notFound('Membership', membershipId);
        assertMayGrantRoles(dto.roles, this.roleGrants, authority);
        assertMayManageMembershipRoles(membership.roles, this.roleGrants, authority);

        const previousRoles = membership.roles;
        const nextRoles: readonly string[] = dto.roles;
        const added = nextRoles.filter((role) => !previousRoles.includes(role));
        const removed = previousRoles.filter((role) => !nextRoles.includes(role));
        const before = removed.length > 0 ? await this.rowsGrant(tx, userId, now) : null;

        const result = await tx.membership.update({
          where: { id: membershipId },
          data: { roles: dto.roles, updatedBy: actor, version: { increment: 1 } },
        });

        // Narrowing: Keycloak first, before any event exists.
        if (before) {
          const after = await this.rowsGrant(tx, userId, now);
          await writeAhead.write(tx, intersectAttributes(before, after), after);
        }

        // Two events, because a consumer usually cares about one direction. The
        // gateway in particular must invalidate its permission cache the moment
        // a role is removed, or the revoked role keeps working until TTL expiry.
        const payload = {
          membershipId,
          userId,
          organizationId: membership.organizationId,
          previousRoles,
          newRoles: dto.roles,
          reason: dto.reason,
        };

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
      }, USER_LOCK_TRANSACTION_OPTIONS)
      .catch(async (error: unknown) => {
        throw await writeAhead.settle(error);
      });

    // Promotion and demotion alike: before ADR-060 neither ever reached the
    // token, because roles were written to Keycloak only when the account was
    // created. A demoted administrator kept administering. After a demotion
    // this only adds what the write-ahead held back.
    await writeAhead.afterCommit();

    return toMembershipView(updated);
  }

  /**
   * Ends a membership. Always a narrowing change (D-064): Keycloak is written
   * before commit, as for a role removed (`updateMembershipRoles`), with the
   * user's active organization moved off it in the same write.
   *
   * Sending it again answers the same — `204`, no second event — so a caller
   * who never saw the first answer (a gateway timeout while this finished) can
   * simply repeat it. Authorized on the membership's roles either way.
   */
  async revokeMembership(membershipId: string, dto: RevokeMembershipDto): Promise<void> {
    const seen = await this.repository.findMembershipByIdIncludingRevoked(membershipId);
    if (!seen) throw RastaError.notFound('Membership', membershipId);

    // Revoking is the other way to take a role off somebody, so it answers to
    // the same rule as replacing one: you may administer a membership whose
    // roles you could have granted, and no other.
    assertMayManageMembershipRoles(seen.roles, this.roleGrants);

    const userId = seen.userId;
    const actor = getContext().userId ?? 'SYSTEM';
    const writeAhead = this.projector.narrowing(userId);

    await this.repository
      .transaction(async (tx) => {
        // Before the membership is touched: a switch to this organization either
        // commits first and is then moved off below, or waits and is refused.
        // The caller's row beside it, and their live authority decides (task
        // 117, F1); `now` is the database's clock after the locks (#402 r1 F3).
        const { now, authority } = await this.authorizeUnderLock(
          tx,
          [userId],
          MEMBERSHIP_ADMIN_ROLES,
        );

        const membership = await this.repository.findMembershipByIdIncludingRevoked(
          membershipId,
          tx,
        );
        if (!membership) throw RastaError.notFound('Membership', membershipId);
        assertMayManageMembershipRoles(membership.roles, this.roleGrants, authority);
        // Already ended — by this same request, sent again: nothing to do.
        if (membership.deletedAt) return;

        const before = await this.rowsGrant(tx, userId, now);

        // `deletedAt` is the end of the membership in every history read: the database's clock,
        // like `validFrom`, not this process's.
        await this.repository.revokeMembership(tx, membershipId, actor);

        await this.moveActiveOrganizationOff(tx, userId, membership.organizationId, actor, now);

        // Keycloak first, before the event that is the gateway's cutoff.
        const after = await this.rowsGrant(tx, userId, now);
        await writeAhead.write(tx, intersectAttributes(before, after), after);

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'Membership',
          aggregateId: membershipId,
          eventName: IDENTITY_EVENTS.MEMBERSHIP_REVOKED,
          topic: IDENTITY_TOPIC,
          organizationId: membership.organizationId,
          payload: validateIdentityPayload(IDENTITY_EVENTS.MEMBERSHIP_REVOKED, {
            membershipId,
            userId,
            organizationId: membership.organizationId,
            reason: dto.reason,
          }),
        });
      }, USER_LOCK_TRANSACTION_OPTIONS)
      .catch(async (error: unknown) => {
        throw await writeAhead.settle(error);
      });

    await writeAhead.afterCommit();
  }

  /**
   * The start of every identity-administration write's transaction (task 117,
   * F1): the user locks — every user in `targets` `FOR UPDATE`, the caller
   * `FOR KEY SHARE`, in id order (`lockUsersInOrder`) — then the database's
   * clock, then the caller's live roles in the organization they act for,
   * refused unless they include one of `required` (`liveAuthority`). Every
   * decision after it measures `authority`, never the token.
   */
  private async authorizeUnderLock(
    tx: ExtendedPrismaClient,
    targets: readonly string[],
    required: readonly string[],
  ): Promise<{
    now: Date;
    authority: readonly string[];
    locked: Map<string, { activeOrganizationId: string | null } | null>;
  }> {
    const context = getContext();
    const locked = await this.repository.lockUsersInOrder(tx, targets, context.userId);
    const now = await this.repository.databaseNow(tx);
    try {
      return { now, authority: await liveAuthority(this.repository, tx, now, required), locked };
    } catch (error) {
      // The token said yes and the database says no: a token minted before a
      // demotion, a revocation or an expiry, still inside its lifetime
      // (ADR-060 § 7). Worth seeing; ids only.
      this.logger.warn(
        { userId: context.userId, organizationId: context.organizationId },
        "Identity administration refused: the caller's token outlived their authority",
      );
      throw error;
    }
  }

  /**
   * What one user's rows grant at `now`, read in the caller's transaction —
   * under the user lock, so nothing changes them meanwhile except the caller.
   * A narrowing change reads it before and after its own change and writes the
   * intersection ahead (D-064).
   */
  private async rowsGrant(
    tx: ExtendedPrismaClient,
    userId: string,
    now: Date,
  ): Promise<PlatformAttributes> {
    const user = await this.repository.findUserById(userId, tx);
    if (!user) throw RastaError.notFound('User', userId);
    const memberships = await this.repository.listMembershipsForUser(userId, tx);
    return platformAttributesFor(user, memberships, now);
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
      // The database's clock, in a statement after the lock: `now()` would be
      // this transaction's start, older than any wait for the lock (#402 r1 F3).
      const now = current ? await this.repository.databaseNow(tx) : null;

      // Read and judged inside the lock, against the database's clock: a
      // revocation or an expiry that committed first is seen here. A caller
      // with no user row holds no membership either, and is refused the same
      // way — a `404` here would tell them something the `403` does not.
      const membership = current
        ? await this.repository.findMembership(userId, dto.organizationId, tx)
        : null;
      // Live, not merely ACTIVE: a membership past its validUntil is not one the
      // caller may act for, and this is where acting for it would begin.
      if (!current || !now || !membership || !isMembershipLive(membership, now)) {
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
      // It may wait on a projection holding the user lock across Keycloak calls.
    }, USER_LOCK_TRANSACTION_OPTIONS);

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
   * A request to join the platform, as the applicant is answered (task 117,
   * F5; task 130, PR #483 r1 R5): one acknowledgement, the same bytes and the
   * same work whatever becomes of it.
   *
   * It used to answer `409 ALREADY_EXISTS` when the username or the email was
   * taken and `201` with the new request's id otherwise. Task 117 made the
   * answer the same bytes; the work behind it still differed — a fresh
   * identity inserted and committed three rows, a held one rolled back at the
   * user's unique index — so the time to the answer still said whether the
   * guess had an account. Now every valid submission does exactly the same
   * thing before it is answered: one intake row, committed
   * ({@link receiveRegistration}). Whether the identity is held is decided
   * afterwards, privately, by the registration worker
   * ({@link processRegistrationIntake}).
   */
  async submitRegistration(dto: SubmitRegistrationDto): Promise<RegistrationAcknowledgement> {
    await this.receiveRegistration(dto);
    return { status: REGISTRATION_ACKNOWLEDGEMENT.status };
  }

  /**
   * The uniform intake: the submission, as validated, written to
   * `registration_intake` and committed — one statement, the same for every
   * applicant, with nothing in it that reads or is constrained by who already
   * has an account. Returns the intake's id, which is the id the request is
   * recorded under if it is.
   *
   * Refuses only on the submission itself: a role nobody can ever grant is
   * one nobody can usefully ask for, and storing it would put attacker-chosen
   * bait in front of a reviewer — refused whoever the applicant is, so it says
   * nothing about who has an account. The grant itself is still checked at
   * approval.
   */
  async receiveRegistration(dto: SubmitRegistrationDto): Promise<string> {
    assertRolesMayBeRequested(dto.requestedRoles);
    const intakeId = `REG_${ulid()}`;
    await this.repository.receiveRegistration(intakeId, dto);
    return intakeId;
  }

  /**
   * Handles one received submission, after its applicant has been answered:
   * the registration worker's step (`RegistrationIntakeWorker`).
   *
   * Records the user in PENDING with no Keycloak account — the product
   * document requires operator review before activation, so nothing here
   * grants access — the request under the intake's id, and its
   * REGISTRATION_SUBMITTED event, and deletes the intake row, in one
   * transaction. When the username or the email is already held — by any
   * user, a pending applicant or a removed one included (both are globally
   * unique, `schema.prisma`) — the unique indexes refuse the user, and the
   * intake row is deleted with nothing recorded: `DUPLICATE`, logged without
   * the username or the email (S-09). `GONE`: another worker has it, or it was
   * handled already.
   *
   * Throws on anything else; the worker defers the row and tries it again.
   */
  async processRegistrationIntake(
    intakeId: string,
  ): Promise<{ outcome: 'RECORDED'; registrationId: string } | { outcome: 'DUPLICATE' | 'GONE' }> {
    const userId = `${ID_PREFIXES.user}_${ulid()}`;

    try {
      const recorded = await this.repository.transaction(async (tx) => {
        const intake = await this.repository.lockRegistrationIntake(tx, intakeId);
        if (!intake) return false;
        // Written by `receiveRegistration` from the validated body, and by
        // nothing else.
        const dto = intake.submission as SubmitRegistrationDto;

        try {
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
        } catch (error) {
          // The id is fresh and `keycloak_id` null: a unique violation on
          // this insert is the username or the email.
          if (isUniqueViolation(error)) throw new RegistrationIdentityTaken();
          throw error;
        }

        await tx.registrationRequest.create({
          data: {
            id: intakeId,
            userId,
            requestedOrganizationId: dto.requestedOrganizationId,
            requestedRoles: dto.requestedRoles,
            justification: dto.justification ?? null,
            documentRefs: dto.documentRefs,
            status: 'PENDING',
            createdAt: intake.receivedAt,
          },
        });

        await this.repository.enqueueEvent(tx, {
          aggregateType: 'RegistrationRequest',
          aggregateId: intakeId,
          eventName: IDENTITY_EVENTS.REGISTRATION_SUBMITTED,
          topic: IDENTITY_TOPIC,
          organizationId: dto.requestedOrganizationId,
          payload: validateIdentityPayload(IDENTITY_EVENTS.REGISTRATION_SUBMITTED, {
            registrationId: intakeId,
            userId,
            requestedOrganizationId: dto.requestedOrganizationId,
            requestedRoles: dto.requestedRoles,
          }),
        });

        await this.repository.deleteRegistrationIntake(tx, intakeId);
        return true;
      });
      return recorded ? { outcome: 'RECORDED', registrationId: intakeId } : { outcome: 'GONE' };
    } catch (error) {
      if (!(error instanceof RegistrationIdentityTaken)) throw error;
    }

    // The username or the email is held: the submission is dropped, and its
    // applicant's details with it.
    const discarded = await this.repository.transaction(async (tx) => {
      const intake = await this.repository.lockRegistrationIntake(tx, intakeId);
      if (!intake) return false;
      await this.repository.deleteRegistrationIntake(tx, intakeId);
      return true;
    });
    if (!discarded) return { outcome: 'GONE' };
    this.logger.log(
      { intakeId },
      'Registration discarded without a record: the username or the email is already held',
    );
    return { outcome: 'DUPLICATE' };
  }

  /**
   * The review queue (`GET /v1/registration-requests`): requests for the
   * organizations this reviewer may provision into — every organization for a
   * `crossOrgRoles` holder (Q-61), otherwise only the one they act for, the
   * scope approve and reject apply — oldest id first, a page at a time.
   *
   * New with task 117: the public submission no longer answers with the
   * request's id (F5), and before it nothing listed requests at all, so the id
   * in that answer was the only way to one. A read, so decided on the token
   * like every read; approving or rejecting is decided again, live, under the
   * request's lock. Every filter is in the query, before the page is cut.
   */
  async listRegistrationRequests(query: ListRegistrationRequestsQuery): Promise<{
    items: RegistrationRequestView[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const context = getContext();
    const everywhere = this.provisioningScope.crossOrgRoles.some((role) =>
      context.roles.includes(role),
    );
    if (context.authType !== 'USER' || (!everywhere && !context.organizationId)) {
      return { items: [], nextCursor: null, hasMore: false };
    }
    const rows = await runUnscoped(
      'the review queue spans the organizations the reviewer may provision into',
      () =>
        this.repository.client.registrationRequest.findMany({
          where: {
            ...(everywhere ? {} : { requestedOrganizationId: context.organizationId }),
            ...(query.status ? { status: query.status } : {}),
            ...(query.username ? { user: { is: { username: query.username } } } : {}),
            ...(query.cursor ? { id: { gt: query.cursor } } : {}),
          },
          include: { user: true },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        }),
    );
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toRegistrationView),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      hasMore: rows.length > query.limit,
    };
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

    // The reviewer's live authority, before Keycloak is asked to create
    // anything (task 117, F1): an early refusal on the database's answer, so
    // a reviewer whose token outlived their role does not leave accounts
    // behind. Not the decision — that is made again under the locks below.
    await this.repository.transaction(async (tx) => {
      await this.authorizeUnderLock(tx, [], REGISTRATION_REVIEW_ROLES);
    }, USER_LOCK_TRANSACTION_OPTIONS);

    // Disabled, and carrying nothing but its provenance: until the database
    // has committed this approval the account must be harmless whatever
    // happens next — a lost response, a crash, a transaction that rolls back
    // (#219 r2). The projector writes its grants and enables it after commit.
    // An account that already exists, or a create Keycloak did not confirm,
    // is resolved below, under the request lock (#219 r3).
    const created = await this.createAccount({
      username: request.user.username,
      email: request.user.email,
      firstName: request.user.firstName,
      lastName: request.user.lastName,
      userId: request.userId,
    });
    // Whether an adoption wrote to the account (D-069): its fenced writes
    // that landed are due at once, and the projection after this approval —
    // whichever way it ends — takes them over.
    let adopted = false;

    const updated = await this.repository
      .transaction(async (tx) => {
        // Decided under the request's row lock, on the status read under it:
        // a rejection or a second approval of this request waits here, and
        // whichever comes second sees the first one's decision and is refused
        // — never an overwrite, never a second event. The update stays
        // conditional on PENDING as well, so it can never be the one that
        // decides; Prisma answers a `where` that matches nothing with P2025.
        const locked = await this.repository.lockRegistrationRequest(tx, registrationId);
        if (locked?.status !== 'PENDING') {
          throw registrationAlreadyDecided('APPROVED', locked?.status);
        }
        // The one lock of every Keycloak writer of the user (`KeycloakProjector`,
        // D-064), after the request lock: adopting an account may write to it.
        // The reviewer's row beside it, in id order, and their live authority
        // decides what is granted, and where (task 117, F1).
        const { authority } = await this.authorizeUnderLock(
          tx,
          [request.userId],
          REGISTRATION_REVIEW_ROLES,
        );
        if (
          !isWithinProvisioningScope(
            request.requestedOrganizationId,
            this.provisioningScope,
            authority,
          )
        ) {
          throw RastaError.notFound('RegistrationRequest', registrationId);
        }
        assertMayGrantRoles(grantedRoles as readonly PlatformRole[], this.roleGrants, authority);
        const keycloakId =
          created.outcome === 'created'
            ? created.keycloakId
            : await this.adoptApprovalAccount(tx, registrationId, request, created.outcome, () => {
                adopted = true;
              });
        const result = await tx.registrationRequest
          .update({
            where: { id: registrationId, status: 'PENDING' },
            data: { status: 'APPROVED', reviewedBy: reviewer, reviewedAt: new Date() },
            include: { user: true },
          })
          .catch((error: unknown) => {
            if (isRecordNotFound(error)) throw registrationAlreadyDecided('APPROVED', 'DECIDED');
            throw error;
          });

        await runUnscoped('activating a user is a platform-level operation', () =>
          tx.user.update({
            where: { id: request.userId },
            data: {
              status: 'ACTIVE',
              keycloakId,
              // The projector enables the account and clears this, once.
              accountActivationPending: keycloakId !== null,
              activeOrganizationId: request.requestedOrganizationId,
              updatedBy: reviewer,
              version: { increment: 1 },
            },
          }),
        );

        try {
          await this.createMembershipRow(tx, {
            membershipId,
            userId: request.userId,
            organizationId: request.requestedOrganizationId,
            roles: grantedRoles,
            actor: reviewer,
          });
        } catch (error) {
          // Somebody gave this person a membership in the organization while
          // the request waited. Which of the two grants should stand is the
          // reviewer's call, so the request stays pending and says why.
          if (error instanceof RastaError && error.code === ERROR_CODES.ALREADY_EXISTS) {
            throw registrationMembershipConflict(registrationId);
          }
          throw error;
        }

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
        // Above the default: resolving an existing account holds the lock across
        // up to five Keycloak calls, each bounded at 10 s by the client.
      }, APPROVAL_TRANSACTION_OPTIONS)
      .catch(async (error: unknown) => {
        // Not approved: the account an adoption wrote stays harmless, which is
        // what an account no user row names should be — confirmed, and its
        // fences deleted, by this projection (`reassertUnlinked`).
        if (adopted) await this.projector.projectAfterCommit(request.userId);
        throw error;
      });

    // The grants, then the account enabled — only now that the approval has
    // committed. Never throws: a failure is logged and counted, and the
    // USER_ACTIVATED and MEMBERSHIP_CREATED events committed above bring the
    // projection back round, as for every membership change (ADR-060 § 5).
    // Until it lands the account stays disabled, and reconcile reports it.
    await this.projector.projectAfterCommit(request.userId);

    return toRegistrationView(updated);
  }

  /**
   * Creates the account an approval or a direct provisioning links — disabled,
   * carrying only `rasta_user_id` — or says why it could not tell (#219 r2,
   * r3; task 117 F6).
   *
   * Runs before the decision's lock: a new account grants nothing and cannot
   * sign in, so whatever becomes of the request it is harmless. Two answers
   * leave an account that may exist and need resolving under the lock
   * (`adoptApprovalAccount`, `adoptProvisionedAccount`): Keycloak's 409 — an
   * earlier attempt's account, whether that attempt's transaction failed or
   * Keycloak's answer to it was lost — and a success without a usable id, or a
   * redirect (F7), which says nothing about which account, if any, was made.
   */
  private async createAccount(
    input: CreateKeycloakUserInput,
  ): Promise<
    { outcome: 'created'; keycloakId: string | null } | { outcome: 'exists' | 'unconfirmed' }
  > {
    try {
      const keycloakId = await this.keycloak.createUser(input);
      return { outcome: 'created', keycloakId };
    } catch (error) {
      if (error instanceof KeycloakCreateUnconfirmedError) return { outcome: 'unconfirmed' };
      if (error instanceof RastaError && error.code === ERROR_CODES.ALREADY_EXISTS) {
        return { outcome: 'exists' };
      }
      throw error;
    }
  }

  /**
   * Resolves the account under the applicant's username, inside the
   * approval's transaction and under its request lock (#219 r3).
   *
   * Adopted only when it provably came from this request: its `rasta_user_id`,
   * an admin-only attribute a user cannot write (`rasta-realm.json`), names
   * exactly this request's pending user, an id minted by `submitRegistration`
   * with the request and belonging to no other. Any other account under the
   * username is somebody else's and is refused with a closed code.
   *
   * And adopted only harmless: disabled and granting nothing. An account of
   * this request that is enabled or carries a grant — what the compensation
   * of earlier versions left when it failed — is first disabled and its
   * grants cleared, under the same lock, so that whatever becomes of this
   * approval it cannot leave a usable account behind. When that repair does
   * not land the approval fails and nothing commits.
   *
   * An unconfirmed create that finds no account cannot be resolved: nothing
   * commits, the request stays pending with a closed code, and the next
   * attempt creates or finds it.
   */
  private async adoptApprovalAccount(
    tx: ExtendedPrismaClient,
    registrationId: string,
    request: { userId: string; user: { username: string } },
    outcome: 'exists' | 'unconfirmed',
    wrote: () => void,
  ): Promise<string> {
    const existing = await this.findOwnAccount(request.user.username, request.userId);
    if (existing === 'missing') throw registrationAccountUnconfirmed(registrationId);
    if (existing === 'foreign') throw registrationAccountTaken(registrationId);
    if (existing.enabled || grantsAnything(existing.attributes)) {
      // Fenced, under the user lock this transaction holds (D-069): a late
      // disable or clear can then never land after the enable unseen.
      wrote();
      await this.projector.adoptHarmless(tx, request.userId, existing);
      this.logger.warn(
        { registrationId, userId: request.userId, keycloakId: existing.id },
        "Approval disabled and cleared an earlier attempt's account before adopting it",
      );
    }
    this.logger.warn(
      { registrationId, userId: request.userId, keycloakId: existing.id, outcome },
      'Approval adopted the Keycloak account an earlier attempt at it created',
    );
    return existing.id;
  }

  /**
   * The account Keycloak holds under `username`, when its `rasta_user_id` — an
   * admin-only attribute a user cannot write (`rasta-realm.json`) — names
   * exactly `userId`: the one rule by which an approval or a provisioning
   * adopts an account it did not see created. `'foreign'`: an account is there,
   * and it is somebody else's. `'missing'`: none is.
   */
  private async findOwnAccount(
    username: string,
    userId: string,
  ): Promise<KeycloakAccount | 'missing' | 'foreign'> {
    const existing = await this.keycloak.findAccountByUsername(username);
    if (!existing) return 'missing';
    const provenance = existing.attributes.rasta_user_id;
    if (provenance.length !== 1 || provenance[0] !== userId) return 'foreign';
    return existing;
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
      // The same lock and the same rule as approval: decided on the status
      // read under it, so a rejection that read PENDING before an approval
      // committed is refused here, rather than marking an approved request
      // REJECTED and emitting a second, contradicting event (#219 r2).
      const locked = await this.repository.lockRegistrationRequest(tx, registrationId);
      if (locked?.status !== 'PENDING') {
        throw registrationAlreadyDecided('REJECTED', locked?.status);
      }
      // After the request lock, the reviewer's row and live authority (task
      // 117, F1): the scope is measured on the roles the database holds now.
      const { authority } = await this.authorizeUnderLock(tx, [], REGISTRATION_REVIEW_ROLES);
      if (
        !isWithinProvisioningScope(
          request.requestedOrganizationId,
          this.provisioningScope,
          authority,
        )
      ) {
        throw RastaError.notFound('RegistrationRequest', registrationId);
      }
      const result = await tx.registrationRequest.update({
        where: { id: registrationId, status: 'PENDING' },
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
    }, USER_LOCK_TRANSACTION_OPTIONS);

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
   * organization they land in; the audit trail. This is that step, a narrowing
   * change like a revocation (D-064):
   *
   * 1. claim the lapse (`lapse_handled_at IS NULL`), so every replica may
   *    sweep and exactly one acts;
   * 2. move the user's active organization off it, if it was the active one;
   * 3. write Keycloak ahead, without the lapsed organization;
   * 4. publish `MEMBERSHIP_EXPIRED` — audit evidence, the gateway's cutoff, and
   *    the durable trigger for re-projection should step 5 fail;
   * 5. re-project the user after commit.
   *
   * 1–4 commit together, or not at all: when Keycloak cannot be written the
   * claim rolls back with the rest, and the next pass tries again. Runs inside
   * the membership's own organization, like a request would: a background job
   * is not trusted more than a person is.
   *
   * `selectedAt` is when the sweep picked the lapse, and only that: every
   * decision is made on the database's clock read after the user lock
   * (#402 r1 F3), so a pass that was delayed — on the lock, on Keycloak, on a
   * slow page — still judges every membership of the user as of the moment it
   * writes. Judged on the old clock, a membership that lapsed meanwhile would
   * be granted again in the write-ahead, after its own cutoff.
   *
   * `signal` is the sweep's shutdown (#402 r1 F4): it cancels the Keycloak
   * call in flight and refuses every further step.
   *
   * Returns whether this call acted, which is `false` when another replica
   * claimed the lapse first.
   */
  async expireLapsedMembership(
    membership: { id: string; userId: string; organizationId: string; validUntil: Date | null },
    selectedAt: Date,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    if (!membership.validUntil || membership.validUntil > selectedAt) return false;
    const validUntil = membership.validUntil;
    const { signal } = options;
    signal?.throwIfAborted();
    const writeAhead = this.projector.narrowing(membership.userId, { signal });

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
          signal?.throwIfAborted();
          // Fresh, after the lock: the clock of every decision below.
          const now = await this.repository.databaseNow(tx);

          const claim = await tx.membership.updateMany({
            where: {
              id: membership.id,
              lapseHandledAt: null,
              deletedAt: null,
              validUntil: { lte: now },
            },
            data: { lapseHandledAt: now },
          });
          if (claim.count === 0) return false;

          const before = await this.rowsGrant(tx, membership.userId, now);
          await this.moveActiveOrganizationOff(
            tx,
            membership.userId,
            membership.organizationId,
            'SYSTEM',
            now,
          );
          const after = await this.rowsGrant(tx, membership.userId, now);
          await writeAhead.write(tx, intersectAttributes(before, after), after);
          signal?.throwIfAborted();

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
        }, USER_LOCK_TRANSACTION_OPTIONS),
    ).catch(async (error: unknown) => {
      throw await writeAhead.settle(error);
    });

    if (acted) await writeAhead.afterCommit();
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
    /** The database's clock, read after the user lock (#402 r1 F3). */
    now: Date,
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

/**
 * What a self-registration answers, recorded or not (task 117, F5). A
 * constant, so the two outcomes cannot drift apart in what they say.
 */
export const REGISTRATION_ACKNOWLEDGEMENT = { status: 'RECEIVED' } as const;

export type RegistrationAcknowledgement = { status: typeof REGISTRATION_ACKNOWLEDGEMENT.status };

/** The username or the email of a registration is already held. Never leaves this file. */
class RegistrationIdentityTaken extends Error {
  constructor() {
    super('registration identity already held');
    this.name = 'RegistrationIdentityTaken';
  }
}

/**
 * The approval transaction's bounds: it may wait on Keycloak under the request
 * lock. A second approval of the same request waits on that lock as long as
 * the first may hold it, so its statements may run as long as the transaction,
 * whatever the session's timeout — behind PgBouncer, the runtime role's own
 * default, which `loadEnv` cannot check (#268): `SET LOCAL`, for this
 * transaction only.
 */
export const APPROVAL_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: APPROVAL_TRANSACTION_TIMEOUT_MS,
  statementTimeoutMs: APPROVAL_TRANSACTION_TIMEOUT_MS,
} as const;

/** The closed codes an approval answers with when it cannot proceed (`approveRegistration`). */
export const REGISTRATION_APPROVAL_CODES = {
  /** The person already holds a live membership in the requested organization. */
  MEMBERSHIP_ALREADY_LIVE: 'MEMBERSHIP_ALREADY_LIVE',
  /** Keycloak holds an account under the username that this request did not create. */
  ACCOUNT_NOT_FROM_THIS_REGISTRATION: 'ACCOUNT_NOT_FROM_THIS_REGISTRATION',
  /** Keycloak did not confirm the account it was asked to create, and none could be found. */
  ACCOUNT_NOT_CONFIRMED: 'ACCOUNT_NOT_CONFIRMED',
} as const;

/**
 * 409: the person was given a membership in the requested organization while
 * the request waited. Nothing was approved, the request is still pending, and
 * nothing a client sent is repeated (S-09).
 */
function registrationMembershipConflict(registrationId: string): RastaError {
  const message =
    'The applicant already holds a live membership in the requested organization; the registration stays pending';
  return new RastaError(ERROR_CODES.ALREADY_EXISTS, message, {
    details: [
      {
        path: 'registration',
        code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE,
        message,
      },
    ],
    internalContext: { resourceType: 'Membership', registrationId },
  });
}

/**
 * 409: Keycloak already holds an account under the applicant's username that
 * this request did not create. It is not adopted, and nothing is written.
 */
function registrationAccountTaken(registrationId: string): RastaError {
  const message =
    'An identity-provider account already exists under this username and was not created by this registration';
  return new RastaError(ERROR_CODES.ALREADY_EXISTS, message, {
    details: [
      {
        path: 'registration',
        code: REGISTRATION_APPROVAL_CODES.ACCOUNT_NOT_FROM_THIS_REGISTRATION,
        message,
      },
    ],
    internalContext: { resourceType: 'KeycloakUser', registrationId },
  });
}

/**
 * 503: Keycloak answered the account's creation without saying which account
 * it made, and none is found under the username. Nothing was approved, the
 * request stays pending, and a retry resolves it (#219 r3).
 */
function registrationAccountUnconfirmed(registrationId: string): RastaError {
  const message =
    'The identity provider did not confirm the account; the registration stays pending and can be approved again';
  return new RastaError(ERROR_CODES.UPSTREAM_UNAVAILABLE, message, {
    details: [
      {
        path: 'registration',
        code: REGISTRATION_APPROVAL_CODES.ACCOUNT_NOT_CONFIRMED,
        message,
      },
    ],
    internalContext: { resourceType: 'KeycloakUser', registrationId },
  });
}

/**
 * 409: another decision on this registration committed first. Nothing was
 * written and no event emitted; the message names neither decision's author.
 */
function registrationAlreadyDecided(to: 'APPROVED' | 'REJECTED', from = 'DECIDED'): RastaError {
  return RastaError.invalidStateTransition(
    'RegistrationRequest',
    from,
    to,
    to === 'APPROVED'
      ? 'Only a pending registration can be approved'
      : 'Only a pending registration can be rejected',
  );
}
