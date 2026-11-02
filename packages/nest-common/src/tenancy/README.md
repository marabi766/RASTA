# Tenant write boundary

Each service installs the guard with its own `Prisma.dmmf.datamodel`, explicit
`scopedModels` and existing unscoped-query logger. Metadata is required even when
a top-level model is platform-wide: `User.update` can mutate `Membership` below it.
DMMF owning relations identify their scalar FK columns; JSON values are never
interpreted as relations.

## Allowed operations and input matrix

Tenant models allow only `findUnique`, `findUniqueOrThrow`, `findFirst`,
`findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `delete`,
`deleteMany`, `create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`,
`updateManyAndReturn` and `upsert`. Prisma 6.19.3 supports both returning variants.
Unknown operations refuse before the query callback. Read/update/delete selectors
always receive the acting organization.

`tenant-write.spec.ts` runs each input row below against create, createMany,
createManyAndReturn, update, updateMany, updateManyAndReturn, upsert-create and
upsert-update, including a mixed bulk batch whose second row is foreign.

| `organizationId` input              | Create / upsert-create        | Update / upsert-update |
| ----------------------------------- | ----------------------------- | ---------------------- |
| Acting tenant scalar                | Keep                          | Keep                   |
| Foreign tenant scalar               | Refuse                        | Refuse                 |
| `{ set: actingTenant }`             | Refuse (invalid create shape) | Keep                   |
| `{ set: foreignTenant }`            | Refuse                        | Refuse                 |
| `null`                              | Refuse                        | Refuse                 |
| `undefined` / omitted               | Fill acting tenant            | No tenant change       |
| `{ set: undefined }`                | Refuse                        | Refuse                 |
| `{ set: null }`                     | Refuse                        | Refuse                 |
| `{ set: actingTenant, extra: ... }` | Refuse                        | Refuse                 |

Upsert validates both branches before executing either. Its create branch uses the
same tenant injection as direct creation. The extension copies inputs and validates
the entire batch before handing any statement to Prisma.

## Nested writes

A relation targeting a guarded model refuses unless its call site uses
`runWithNestedTenantWrite({ relation: 'Model.field', reason: 'reviewed reason' }, fn)`.
Return or await the query within the callback; lazy Prisma execution retains the
review. The review names exactly one relation and cannot authorize another relation
at greater depth. It preserves all data checks and adds tenant filters to nested
selectors. It never grants `runUnscoped` privileges.

Traversal covers create, createMany, connect, connectOrCreate, set, disconnect,
update, updateMany, upsert, delete and deleteMany at every relation depth. Boolean
mutations of tenant relations refuse because they supply no selector to constrain.
Reviewed `set` also refuses: it can disconnect omitted foreign children, including
when given an empty list. To-one create/connect/connectOrCreate/upsert
replacements involving a guarded parent or target also refuse: they can clear a previous foreign child's FK, or evict a
foreign parent through a unique FK. FK ownership alone cannot prove these effects
are tenant-bound. Use separate guarded
operations within a transaction for these cases. Unknown relation
operations also refuse.

Inventory of current production nested writes across all 17 service `src` trees:

| Service                                                                                                                                    | Tenant-targeting nested writes                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| marketplace                                                                                                                                | `order/order.service.ts`, `OrderService.place`: `Order.lines.create`; explicitly reviewed because the order and its priced buyer-owned lines must commit together. Each line still receives/validates the acting buyer. |
| analytics, asset, construction, contract, document, economic, fleet, identity, inventory, maintenance, notification, procurement, supplier | None found; the other `create` properties are top-level upsert branches.                                                                                                                                                |
| api-gateway, audit, organization                                                                                                           | None found; these services do not install this extension.                                                                                                                                                               |

Inventory source search: all relation mutation names in every service's source,
compared against the Prisma relation fields; excluded generated clients and unit
fixtures. Every installer receives the whole datamodel. Service suites exercise
actual generated clients, including interactive transaction clients.

## Context and deliberate platform operations

A missing request context or missing acting organization refuses access to guarded
models, including nested access under an unguarded parent. Platform authority such
as SYSTEM_ADMIN alone does not bypass this boundary. Plain operations on unguarded
platform models retain their current tenantless semantics. A missing service tenant
claim retains `SERVICE_TENANT_CONTEXT_INVALID`; missing user/request context stays
an internal fault, now with a fixed platform error. Financial rule models
with nullable organization IDs retain their explicit service predicates/exemptions.

`runUnscoped(reason, fn)` retains its existing explicit platform-wide semantics,
lazy-promise handling and query logging. It permits deliberate cross-tenant ledger
entries, issued settlement books, asset ownership transfers, background processing
and platform governance. Nested-write review does not provide that bypass.

Guard refusals use platform error codes and fixed input-free messages before
the query callback. Composite-FK violations fail the database statement itself.
In an interactive transaction, propagate the refusal so Prisma
rolls back preceding domain writes, ledger entries, outbox rows and idempotency
state; the identity and economic integration regressions assert this rollback.

## Raw SQL

Prisma raw SQL is outside `$allModels`. `raw-sql-inventory.spec.ts` scans every
service `src` tree, including unit fixtures and excluding generated code. All queryRaw/executeRaw variants (including typed queries), calls and extracted method references
must match `raw-sql-inventory.json` by path, complete call-expression SHA-256 and
occurrence. Entries state either `has bound organization predicate` or an explicit
`platform-wide: <reason>`. New, changed, duplicated, extracted, unclassified and obsolete sites
fail the guard. Line numbers help review and are not the identity of a site.

This is a reviewed call-site inventory, not a SQL parser or a runtime SQL firewall.
Bound inserts, cross-party lookups, singleton reference data, worker queues, locks,
clocks and transaction controls have specific reasons. SQL delegated to a constant
or helper is reviewed at its listed caller; changes to those helpers still need
ordinary code review. Raw SQL is never made safe by wrapping it in this extension.

## Scalar foreign keys (D-119, staged)

Every installer names its service family. `scalar-relation-policy.ts` explicitly
lists the remaining legacy relations; its schema/installer test pins that list.
New or unclassified scalar FK writes refuse, including through nested data and
both upsert branches. The legacy list is rollout debt, not reviewed safety.

Marketplace classifies all twelve owning relations. `Offer.product` and
`OrderLine.offer` are reviewed cross-party links (ADR-037/042). Seven same-tenant
links use additive, validated composite database FKs; returns retain their three
existing composite FKs. The database checks tenant equality in the write itself,
including bulk/returning operations and concurrent parent ownership changes.
Nested creates validate the child tenant then inherit the composite tenant column
from their guarded parent, as Prisma requires. No ownership SELECT is added.

Deploy the migration before the new generated client/application. Invalid existing
links abort migration validation without changing rows; operators must reconcile
those rows explicitly. Rollback drops only the additive constraints/indexes and
preserves the original ID-only FKs and all data. Index creation and validation
can lock populated tables: schedule the migration accordingly. Raw-SQL discovery
(F2/FU-011) remains a separate follow-up.
