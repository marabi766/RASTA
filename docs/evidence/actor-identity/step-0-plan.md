# Stable actor identity for separation of duties (#188): STEP 0 plan

> Branch `fix/platform-stable-actor-identity`, cut from `origin/main` @ `71bac91`. This file is the plan the PM
> ruled on before any code was written. Line numbers are at `71bac91`.

## 0. Rulings (PM, on this plan, 2026-10-02)

GO, with these answers. Where they differ from the plan below, they win.

- **Q1:** a note in ADR-060 plus docs/09 § 9.2 and § 9.3. No new ADR.
- **Q2:**
  - (a) A generic `ACTOR_IDENTITY_UNKNOWN` (422). Folding #175's `CREATOR_IDENTITY_UNKNOWN` into it is part C.
  - (b) A missing `rasta_uid` → `403 FORBIDDEN`, fixed message, no claim values.
- **Q3:** migration names are timestamps and need no reservation: `<timestamp>_actor_stable_identity`.
- **Q4:** three PRs.
  - **A (#192):** `@rasta/nest-common` only, plus unit tests with paired tokens through the real AuthGuard, plus the
    ADR-060 and docs/09 notes. No service changes.
  - **B:** after #190 merges: construction A1, B1 and C1, plus the migration and paired-token tests.
  - **C:** after #175 merges: economic D1 on the shared helper, with `CREATOR_IDENTITY_UNKNOWN` folded in.
  - No construction or economic file is touched before those merges.
- **Q5:** acceptable, with no operator path. The remedy is documented: a pending or draft policy whose author identity
  predates the migration is withdrawn and submitted again, which records the new identity; an old bid-opening proposal is
  withdrawn and proposed again. Fail closed stands.
- The sweep's conclusions on the organization-based and self-access sites are accepted.

Codex review of A (PM ruling, 2026-10-02):

- **HIGH 1.** Complete identities with different issuers compared as DISTINCT. After an issuer URL change, one Keycloak user
  (the same `sub`, perhaps a new `rasta_uid`) therefore looked like "another person" against a stored actor. Now:
  - equal userIds → SAME;
  - equal issuers → the subjects decide (SAME or DISTINCT);
  - **different issuers → UNKNOWN**, which fails closed.

  There is no alias mapping. An issuer migration needs an explicit, audited mapping later. This is tested with an actor
  persisted under the old issuer, through the real verifier and guard.

- **HIGH 2.** Accepted as staged. #188 stays open until parts B and C merge, and part A claims no fix.

As built in A: the helper module is `auth/separation-of-duties.ts`. It is not `actor-identity.ts`, because the A-03 import
check in the guard specs refuses any import path that mentions `identity`. `UserClaims.issuer` is optional (`verifyUserToken`
always sets it) so that the services' typed stub verifiers need no change in A. A missing issuer makes the stable identity
unknown.

## 1. The defect

`AuthGuard` sets `userId = claims.rastaUserId ?? claims.sub` (`packages/nest-common/src/guards/auth.guard.ts:199`). One
person can therefore carry two user ids:

- a token without `rasta_uid` gives the IdP subject, and one with it gives the platform id;
- or two platform ids for one subject, if Keycloak's `rasta_uid` attribute is ever wrong.

Every check of the form "this actor is not that actor", compared on `userId`, passes for one person who holds two valid
tokens.

## 2. The helper API (`@rasta/nest-common`)

### Request context and guard

`RequestContext` and `AuthState` gain two fields:

- **`issuer`** is the token's verified `iss`. `jwtVerify` already requires it to equal the one configured issuer, so it is
  the same for every accepted user token.
- **`platformUserId: boolean`** is `true` only when the token carried `rasta_uid`. It replaces #175's `userId === subject`
  heuristic.

`subject` (the `sub` claim) is already on the context.

### `@RequirePlatformUserId()`

A route or class decorator. On a route that carries it, the `AuthGuard` refuses a **user** token without `rasta_uid` with
a 403, before the handler runs. Service and anonymous callers are not affected; `@AllowService` and `@Public` still decide
for them.

### `auth/separation-of-duties.ts` (planned as `auth/actor-identity.ts`)

```ts
export interface ActorIdentity {
  userId: string;
  issuer: string | null; // null: not recorded (a row older than this change)
  subject: string | null;
}

/** The calling user as an ActorIdentity. 403 for a non-USER caller. */
export function currentActor(): ActorIdentity;

/**
 * SAME     the userIds match, or both issuer+subject pairs are present and match
 *          (also: one side's userId equals the other's subject, i.e. a row written
 *          from a token with no rasta_uid)
 * DISTINCT both sides carry issuer+subject, and nothing above matched
 * UNKNOWN  anything else: at least one side has no recorded identity
 */
export function compareActors(a: ActorIdentity, b: ActorIdentity): 'SAME' | 'DISTINCT' | 'UNKNOWN';

/** Fail closed: UNKNOWN counts as the same person. */
export function sameActor(a: ActorIdentity, b: ActorIdentity): boolean;

/** SAME → 403 FORBIDDEN "Separation of duties: <what>"; UNKNOWN → ACTOR_IDENTITY_UNKNOWN (Q2). */
export function assertDistinctActors(a: ActorIdentity, b: ActorIdentity, what: string): void;
```

A site that already has its own refusal code keeps it: construction keeps `SECOND_PERSON_REQUIRED`. Such a site calls
`compareActors` and maps the result itself. This is a comparison utility, not a business rule (A-03): which two actors must
differ stays in each service.

## 3. Every comparison site found

### Switched: an actor compared with another actor for separation of duties

| #   | Site                                                                                                          | Comparison                                                                                    | Change                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `construction-service/src/tender/tender-open.service.ts:306`                                                  | bid-opening four-eyes (Q-91): `openingProposedBy === principal.actor`                         | `compareActors(proposer, caller)`. SAME → 422 `SECOND_PERSON_REQUIRED`, as today. UNKNOWN (the proposal is older than this change) → refused. The remedy, which already exists, is for the proposer to withdraw it and propose again.                                                          |
| A2  | `tender-open.repository.ts:150` (written from `tender-open.service.ts:435/445`)                               | where the proposer is stored                                                                  | Also store `opening_proposed_by_issuer` and `opening_proposed_by_subject`.                                                                                                                                                                                                                     |
| B1  | `construction-service/src/approval/policy.service.ts:464` `assertFourEyes`                                    | policy four-eyes (Q-70 (7)): `createdBy === approver \|\| submittedBy === approver`           | `compareActors` against the author and against the submitter. SAME, or UNKNOWN for either, counts as the approver's own work. Which own work is refused stays exactly as it is today: a UNION-authored policy always; a SYSTEM_ADMIN-authored one while `CONSTRUCTION_POLICY_FOUR_EYES` is on. |
| B2  | `policy.service.ts:162` (create) and `:209` (submit)                                                          | where the author and submitter are stored                                                     | Also store `created_by_issuer`/`_subject` and `submitted_by_issuer`/`_subject`.                                                                                                                                                                                                                |
| C1  | **#190 (open)**: `tender/evaluation.service.ts:665` (branch line numbers)                                     | `EVALUATOR_NOT_TENDER_AUTHOR`: `tender.createdBy === actor \|\| tender.publishedBy === actor` | Not on `main`. Switch it after #190 merges. This needs `tender.created_by_*` and `published_by_*` identity columns, which are written where the tender is created and published (Q4).                                                                                                          |
| D1  | **#175 (open)**: economic `payment-reconciliation.operator.ts` `isCreator`, the proposer check, `authorize()` | economic four-eyes (already iss+sub)                                                          | Untouched while #175 is open. Afterwards the call sites switch to the helper and `authorize()` to `platformUserId`; behaviour stays the same (Q4).                                                                                                                                             |

Routes that get `@RequirePlatformUserId()` (both sides of every four-eyes pair):

- the bid-opening routes `propose`, `open` and `withdraw`;
- policy `create`, `submit` and `approve`;
- later, #190's evaluation routes.

Construction's `livePrincipal` already looks up identity-service memberships by `userId`, which in practice refuses an
unmapped IdP subject. The decorator makes that refusal explicit, and the same in every service.

### Checked and left unchanged

| Site                                                                                                             | Why it is not separation of duties                                                                                          |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tender-open.service.ts:470` (withdraw: proposer only)                                                           | An ownership grant: equality **allows**. A second id only loses access (fails closed). Kept as an exact `userId` match.     |
| `tender-open.service.ts:314`, `:875`                                                                             | Compare a stored proposal with itself as read before the lock (same proposal?), not two actors.                             |
| `tender-open.service.ts:958`                                                                                     | Whether the event includes `proposedBy` (reporting only). Unchanged.                                                        |
| `fleet/access.ts:76`, `maintenance/access.ts:121`, `repair-order.service.ts:1111`, `identity.service.ts:179/332` | Self-access grants (the driver themselves, the reporter themselves, self). Equality allows, so they fail closed.            |
| `supplier/access.ts` `assertNotDecidingOwnCase`                                                                  | Separation of duties on **organization membership** (D-2), not `userId`. Not affected.                                      |
| `marketplace/access.ts:112/224`                                                                                  | Organization ids.                                                                                                           |
| `economic/provenance/confirm.ts:107`                                                                             | Checks an event against the owner's fact. No two actors.                                                                    |
| `construction/tender/membership.client.ts:137`                                                                   | A sanity check on the response.                                                                                             |
| construction need and progress approvals                                                                         | Authority is organization-based. There is **no person-level "approver ≠ submitter" rule** today, and none is invented here. |

## 4. Migration (construction-service; the name to be reserved by the PM)

Nullable `TEXT` columns:

- `tender`: `opening_proposed_by_issuer`, `opening_proposed_by_subject`;
- `approval_policy`: `created_by_issuer`, `created_by_subject`, `submitted_by_issuer`, `submitted_by_subject`;
- after #190: `tender.created_by_*` and `published_by_*`.

Each column carries a CHECK that the issuer and subject are both set or both null, and never blank.

**No backfill.** The issuer and subject behind an old `userId` cannot be known from construction's own data. Reading
identity-service's `keycloak_id` would break A-01, and it would still be a guess. Old rows stay null, which makes the
comparison UNKNOWN, which fails closed: never a silent pass. This is the same rule as #175's `CREATOR_IDENTITY_UNKNOWN`.

New writes always fill the columns. A non-null CHECK on new rows is not possible without breaking old rows, so tests cover
it instead.

`down.sql` drops the columns. After a re-up, the rows are UNKNOWN again, which is still fail-closed.

## 5. Tests

- **nest-common unit:**
  - the full `compareActors` matrix: U1 vs U2 with the same issuer+subject → SAME; with vs without `rasta_uid` → SAME;
    null identity → UNKNOWN; different people → DISTINCT;
  - `assertDistinctActors`;
  - `currentActor`.
- **AuthGuard spec:**
  - `issuer` and `platformUserId` reach the request context;
  - `@RequirePlatformUserId()` returns 403 through the real guard for a token without `rasta_uid`;
  - service and anonymous callers are unaffected.
- **construction HTTP int-specs** (real `AuthGuard`; the `api-helpers.ts` stub verifier gains `iss`). For A1 and B1:
  - platform ids U1 and U2 with one `sub` → refused;
  - proposer with `rasta_uid`, approver the same `sub` without it → 403;
  - an old row with null identity → refused;
  - a genuinely different person → allowed (the positive control).
- **Migration:** `verify-migration-reversible` for construction, plus the CHECKs.

## 6. Questions for the PM

- **Q1 (ADR).** I propose a note in **ADR-060**, which already owns the user-token claims and `rasta_uid`, plus docs/09
  § 9.2 (claims) and § 9.3 (a new "separation of duties" paragraph). ADR-020 is service-to-service, and ADR-066 is bid
  confidentiality, so neither fits as well. Is a note enough, or do you want a new ADR (ADR-068)?
- **Q2 (error codes).**
  - (a) A generic `ACTOR_IDENTITY_UNKNOWN` (422, like #175's `CREATOR_IDENTITY_UNKNOWN`), with #175's code folded into it
    after #175 merges? Or keep construction's own codes and only add one for UNKNOWN?
  - (b) A missing `rasta_uid` on a decorated route → plain `FORBIDDEN` (403) with a fixed message, no new code. OK?
- **Q3 (migration name).** Please reserve one, e.g. `2026100XXXXXXX_actor_stable_identity`, in construction-service.
- **Q4 (sequencing).**
  - #190 rewrites `tender-open.service.ts` (about 190 lines) and owns C1. I need to touch `tender-open.service.ts` (the
    four-eyes branch around `:306` and `recordProposal`), `tender-open.repository.ts` (`:150`, the proposal write and the
    lock select), `policy.service.ts` (`:162`, `:209`, `:464`), the construction access and controller decorators,
    `schema.prisma`, and a new migration.
  - Should I wait for #190, then merge main and do A, B and C in one go? (I recommend this.)
  - D1 (economic) follows #175 the same way.
- **Q5 (old pending items).**
  - A pending opening proposal from before the migration can be withdrawn and proposed again.
  - A policy that is `PENDING_PLATFORM_APPROVAL` (or in `DRAFT`) whose `created_by` identity is unknown can **never** be
    approved under fail-closed, because its author identity never becomes known. Is that acceptable (the remedy is to
    write a new policy), or do you want an operator path? I will not invent one.
