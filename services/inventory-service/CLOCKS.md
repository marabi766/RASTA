# Inventory command clocks (audit F1)

Expiry uses one database wall-clock reading (`clock_timestamp()`) after every stock lock and
reservation lock needed for the decision. The command reuses that instant for reservation,
stock balance, movement and event writes. `expires_at <= decision instant` is due, including
equality. Transaction start (`now()`) is unsuitable for deadlines after a lock wait.

The expiry batch locks at most batch-size + 1 ACTIVE reservations with a non-null deadline per
item, ordered by deadline and id, **without filtering by a pre-lock time**. After the final lock,
it filters those candidates by the single decision instant. All other writers take the parent
stock lock first, so the candidate set is stable. Backlog totals use the same instant; they do
not lock or expire the remaining rows. Multi-item reservations prepare every batch before the
clock is read. Issue/release also lock their target reservation before sampling.

| CommandRunner command                                                           | Locks / instant                                                                                                      | Does expiry depend on it?                                                                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserve` (create reservation)                                                  | All stock items in ascending id order, then their bounded reservation candidates; wall clock after the final lock    | Yes; validate caller's expiresAt and max TTL, expire due reservations and write all lines at that instant                                         |
| `issue`, `release`                                                              | Stock item, target reservation, bounded expiry candidates; wall clock after all locks                                | Yes; due target is refused even beyond the batch                                                                                                  |
| `receive`                                                                       | `ensureItem` may wait on the unique index, then stock item and bounded reservation candidates; wall clock after them | Yes for expiry, balance, movement and event. Empty-item creation metadata in `ensureItem` retains transaction time; it makes no deadline decision |
| `adjust`                                                                        | Stock item and bounded reservation candidates; wall clock after them                                                 | Yes; availability/backlog uses that instant                                                                                                       |
| `create_warehouse`                                                              | Claim only; transaction time                                                                                         | No expiry or deadline decision; unchanged                                                                                                         |
| `create_shipment`                                                               | Claim only; transaction time                                                                                         | No expiry or deadline decision; unchanged                                                                                                         |
| `dispatch_shipment`, `deliver_shipment`                                         | Claim then shipment row; transaction time, clamped to locked updatedAt for rows/events                               | No expiry or deadline decision; unchanged                                                                                                         |
| `create_return_shipment`                                                        | Claim then per-request dispatch advisory lock; transaction time                                                      | No expiry or deadline decision; unchanged                                                                                                         |
| `receive_return_shipment`, `inspect_return_shipment`, `resolve_return_shipment` | Claim then return-shipment row; transaction time, clamped to locked updatedAt for rows/events                        | No expiry or deadline decision; unchanged                                                                                                         |
| Expiry batch / sweeper (outside CommandRunner)                                  | Stock item with SKIP LOCKED, then bounded reservation candidates; wall clock after them                              | Yes; same equality and timestamp rules as commands                                                                                                |

The replay fence (`shared/idempotency.ts`, FU-171) is one more deadline decision, on the same clock:
`clock_timestamp()` read inside the claim's insert transaction, and again after the insert that lost,
the read of the existing row and the visibility guard, before a stored response leaves. This replica's
clock only refuses early (nothing read or written) and keeps its existing lease and retention duties.

There is no inventory confirm command. The dispatch-withdrawal fence (outside CommandRunner)
uses the per-request advisory lock and transaction time for metadata, with no deadline decision.
The stock updated_at monotonic clamp stays in place.

A refused issue/release rolls back its expiry writes. The reservation remains ACTIVE in storage
until a later expiry batch persists EXPIRED, releasing reserved stock with exactly one RELEASE
movement and STOCK_RELEASED event. On-hand never falls for expiry. ExpiryBacklog retains its
separate bounded committed work-off batch. Reads never derive status from a clock. Claim,
replay, version and tenant rules are unchanged.

# Other service verdicts (report only)

A source scan of `transactionNow` and `SELECT now()` found these other service helpers:

- Supplier: formula activation (`src/performance/formula.service.ts:108-110`) samples transaction
  time before `lockActive`; stale ordering/timestamp risk needs follow-up. Supplier suspension,
  reinstatement and qualification decisions also stamp before their guarded updates/implicit
  locks; assess timestamp ordering separately. Registration and formula creation have no expiry
  decision. The repository's standing query (`src/supplier/supplier.repository.ts:523`) uses now()
  as a read-only REPEATABLE READ snapshot marker, which is appropriate.
- Construction: `src/shared/clock.ts` already separates `decisionInstant` (database wall clock
  after locks for deadline checks) from `transactionNow` (row/event metadata). No inventory-style
  clock change here.
- Contract: `src/shared/clock.ts` already separates `databaseClock` (post-lock signatures/policy
  decisions) from transaction timestamps and the transaction-budget start. No change here.

These are a clock-pattern review, not a new full audit of those services. No other service is
modified by this fix. ADR-056 and its implementation plan describe locking/atomicity but do not
claim that transaction-start time is safe for post-lock expiry decisions.
