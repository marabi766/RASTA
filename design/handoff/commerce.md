# Handoff — Marketplace & Economic (بازار و مالی)

| | |
| --- | --- |
| Domain | `marketplace-service` + `economic-service` |
| Backend baseline | **`main@69dbcc3`** (resolved `69dbcc31eed8`), read 2026-08-31 — 78 commits after `e4f9b1e7867b`, 9 after the previous checkpoint |
| Surfaces | `offers` (مقایسه پیشنهادها), `orderDetail` (جزئیات سفارش), `wallet` (کیف پول و تسویه) |
| Status strip | all three `IMPLEMENTED IN BACKEND · ready for frontend` |
| Design source | `design/source/RASTA-Web-Portal.dc.html` |
| Design branch | `design/claude-design` (see § 7 — the push could not be performed from here) |

Both services exist upstream now. These three surfaces were **re-grounded**, not merely
restyled: the previous versions were drawn while both services were `PLANNED` and
contained claims the real code refuses to make.

---

## 1. What was removed, and why

| Removed claim | Why it is false |
| --- | --- |
| Supplier score column (`۴٫۱`, `۴٫۶`, `۳٫۲`) and a 30 %-weighted rating criterion | `supplier-service` does not exist. `OfferView.supplierQualification` is the literal string `UNAVAILABLE` — never `true`, never `false`. A `false` would say a check ran and failed; the UI must not render a verdict nobody reached (ADR-041 § 1). |
| Weighted multi-criterion ranking with configurable weights and a «پیشنهاد سامانه» badge | There is no scoring engine. `searchProductsQuerySchema.sort` accepts exactly `PRICE_ASC`, `PRICE_DESC`, `LEAD_TIME_ASC` — `RATING` is deliberately absent (ADR-042 § 2). The badge now reads «انتخاب خریدار» and marks the buyer's own pick. |
| «تأمین‌کننده تأییدشده · ۳۱ سفارش موفق» plus four performance bars | Nothing produces these numbers. Replaced by an explicit qualification panel: identity ✓ (from the signed token), qualification / permits / suspension `UNAVAILABLE`, performance score «وجود ندارد». |
| Commission added **on top** of the order (`۳۰۴٬۰۰۰٬۰۰۰ + ۲٪`) | `TransactionView` carries `grossAmountMinor`, `commissionAmountMinor`, `netAmountMinor`. Commission is deducted from the supplier's net, not added to the buyer's total. |
| A 2 % commission rate shown as fact | `createCommissionRuleSchema.rateBasisPoints` is required with **no default**; `docs/24` Q-08 is open. Sample rates must carry the label «نمونه — نیازمند تصویب» (ADR-023). Zero commission is displayed as «قاعده فعالی مطابقت نکرد», never «رایگان». |
| «تخفیف تجمیع تقاضا» line | `procurement-service` does not exist. |
| A separate «حمل» order line | Shipping is not modelled; every order line is an `Offer`. |
| «موجودی» read as warehouse stock | `offer.availableQuantity` is the supplier's own declaration. It decrements under a row lock with a `CHECK (available_quantity >= 0)` behind it, but **no warehouse reservation happens** — `inventory-service` does not exist. Labelled «عدد اعلامی، نه موجودی انبار». |
| «هر مبلغی که کلاینت بفرستد نادیده گرفته می‌شود» | Wrong in a load-bearing way. `createOrderSchema` is `.strict()` and has **no price field**, so a client that sends one gets `400 VALIDATION_FAILED`. Ignoring is quiet; refusing tells a client that thinks it sets the price that it does not (ADR-037 § 5). |
| «سبد خرید» as a working step | The `cart` prefix is routed but has no handler — it answers 404 (ADR-037 § 3). |

---

## 2. `offers` — catalogue and offer comparison

**Routes.** `GET /v1/products` (search), `GET /v1/products/{id}/offers`, `GET /v1/offers`
(the supplier's own, all states), `POST /v1/offers`, `PATCH /v1/offers/{id}`.
Search carries a tighter rate limit than the default: 60 requests / 60 s.

**Sort control.** Three chips only, matching the enum. Text matching runs on a trigram
index; lead time is the supplier's declared commitment and nothing measures it.

**Table columns.** ترتیب · تأمین‌کننده (+ `صلاحیت بررسی نشده — UNAVAILABLE`) · قیمت واحد ·
جمع · زمان تحویل اعلامی · حداقل سفارش · اعلام تأمین‌کننده.

**Order guards panel** — every entry is a real refusal in `order/pricing.ts` or
`order.controller.ts`:

| Rule | Response |
| --- | --- |
| Price in the request body | `400 VALIDATION_FAILED` |
| Offer not `PUBLISHED`, or unknown | `404` — an unpublished offer does not exist to this buyer |
| Below `minimumQuantity`, or above `availableQuantity` | `422` business rule |
| Two suppliers, or two currencies, in one order | `422` — one obligation cannot have two payees |
| The same `offerId` twice on one order | `422` — merging would change the confirmed quantity |
| Total ≤ 0 | `422` |
| Missing / short `Idempotency-Key` | `400`, key must be ≥ 8 characters |

**Basket panel.** Gross from the offer row, commission `۰` with the reason stated, hold
against the wallet's available balance. Hold is real (economic-service); **top-up runs
through `MockPaymentProvider`** — no bank connection exists.

---

## 3. `orderDetail` — the order lifecycle

**Eleven statuses** (`ORDER_STATUSES`): `PENDING`, `FUNDS_HELD`, `CONFIRMED`,
`AWAITING_RECEIPT_CONFIRMATION`, `RECEIPT_CONFIRMED`, `SETTLING`, `COMPLETED`,
`DISPUTED`, `CANCELLING`, `CANCELLED`, `FAILED`. The status chip shows the Persian label
**and** the enum name, because the enum is what a developer greps for.

**Timeline** renders the normal path from `ORDER_TRANSITIONS`. Two absent edges carry the
whole safety model and are called out in copy:

- `DISPUTED` has **no** edge to `SETTLING`. A dispute stopping settlement is a missing
  edge, not a check somebody has to remember.
- `COMPLETED` / `CANCELLED` / `FAILED` have no outgoing edges, so a replayed command on a
  finished order cannot produce a second financial effect.
- `SETTLING` can fall back to `RECEIPT_CONFIRMED`: the order is still authorised, the
  attempt is not.

**Who may do what** (`access.ts`, S-03 / BOLA):

| Command | Who | Note |
| --- | --- | --- |
| `confirm`, `fulfill` | supplying organization only | statements about what the seller did |
| `confirm-receipt` | **buying organization only** | the one command that permits settlement — not the supplier (self-confirming delivery), not a platform operator (who was not there) |
| `cancel`, `disputes`, `reviews` | buying organization only | dispute reason ≥ 10 characters |
| `disputes/resolve` | `SYSTEM_ADMIN` / `UNION_ADMIN` only | outcome `SETTLE` or `REFUND`; no third option, because a dispute that is neither leaves money held forever |
| any read | either named party | a third organization gets **404**, not 403 — refusing by name would confirm the order exists |
| `AUDITOR` | refused everywhere | province oversight is aggregate-only, three-layer defence |

**Timeouts — ADR-043.** Two configurable windows (`MARKETPLACE_FULFILLMENT_WINDOW_DAYS`
default 7, `MARKETPLACE_RECEIPT_WINDOW_DAYS` default 3, reminder interval 3). Expiry
moves **nothing**: it writes an `order_status_history` row of type `REMINDER` where
`fromStatus === toStatus`, increments `reminderCount`, sets `lastReminderAt`, and raises
`rasta_marketplace_orders_overdue`. No auto-confirmation, no auto-cancellation, no timer
with a financial effect. The defaults are labelled ASSUMPTION in `docs/08` — show them as
configuration, never as rule. A reminder is **not a notification**: nothing is delivered,
because `notification-service` does not exist.

**Reviews.** `POST /orders/{id}/reviews` — rating 1–5, only after `COMPLETED`, only once.

**Not rendered as working:** the Saga's `RESERVE_STOCK` step exists as a named step with
status `DEFERRED` and no activity; `notifySupplier` is not implemented at all.

---

## 4. `wallet` — economic-service

**Routes.** `/v1/wallets`, `/v1/transactions`, `/v1/settlements`, `/v1/payment-intents`,
`/v1/commissions`, `/v1/rewards` — all requiring `Idempotency-Key` on unsafe methods.
`/v1/ledger` is restricted at the gateway to `SYSTEM_ADMIN` and `UNION_ADMIN`.

**Balances** (`WalletView`). `ledgerBalanceMinor` is derived from the ledger — the sum of
the organization's wallet and escrow accounts (ADR-034). `availableBalanceMinor` is always
`ledger − pending`, and that equality is enforced **in the database**, not in service code.
The KPI copy says so.

**Transaction state machine** (`transaction/state-machine.ts`), shown as a panel:
`CREATED → HELD → PENDING_SETTLEMENT → SETTLED`, with `DISPUTED` reachable from `HELD` and
`PENDING_SETTLEMENT` and leaving only by an explicit human `RESOLVE_DISPUTE` or `REFUND`.
`CREATED → PENDING_SETTLEMENT` directly is legitimate: an obligation recorded from an
approval has no escrow behind it (ADR-032). Illegal transitions answer
`409 INVALID_STATE_TRANSITION`.

**Amounts.** Every amount is a **string in minor units**, in and out. A JSON number would
truncate a large rial figure inside the client's parser, where no validation can see it
(ADR-022). Commission rate is an integer in basis points — 2.5 % must be exactly 250.

**Holds.** `placeHoldSchema.transactionId` is required: a hold with no obligation behind it
is money removed for no stated reason, and nothing would ever release it. The disputed
order's hold stays `ACTIVE` until an operator decides.

**Ledger.** Double entry; the only correction is a reversing journal with a reason of at
least a sentence, stored permanently. `TrialBalanceView.balanced` is **the proof, not a
report** — `false` is a critical alarm (docs/10 § 10.3).

**Rewards.** `creditPerPointMinor` is optional with **no default**, so rules are
points-only and post no journal while Q-09 is open. `RewardBalanceView.level` is `null`
until a level ladder exists (Q-13) — not «سطح صفر». `periodCap` requires `periodType`:
a cap without a window is not a cap.

**Top-up.** `WALLET_TOP_UP` is deliberately absent from `createTransactionSchema` — money
entering a wallet goes through the payment provider and records its own transaction, so a
caller cannot conjure a credit with no payment behind it. That type never attracts
commission.

---

## 5. Payment abstraction, and the states the design now shows

Added at the `69dbcc3` checkpoint. Everything below was read from
`payment/provider.ts`, `payment/payment.service.ts`, `payment/payment.controller.ts`,
`wallet/wallet.controller.ts` and the two new integration suites
(`payment-provider-contract.int-spec.ts`, `wallet-races.int-spec.ts`).

**Provider disclosure is an endpoint, not a UI string.** `GET /v1/wallets/provider`
answers `{provider, simulated, notice}`. In this MVP that is `mock`, `true`, and
"Simulated payment provider. No bank connection, no real funds, no custody of money."
The wallet surface reads it and shows it; a hard-coded «حالت نمایشی» would become a lie
the day a real provider is wired, and the contract suite asserts precisely that inverse —
a live provider must not keep repeating the simulated notice. **No banking connectivity is
claimed anywhere.**

**Intent lifecycle.** `CREATED → AUTHORIZED → CAPTURED`, with `FAILED` reachable from
either step and `REFUNDED` only from `CAPTURED`. The wallet is credited **only on
capture**, in the same database transaction that records it — crediting on authorisation
would put value in a wallet that a failed capture then has to claw back.

| State shown | Grounded in |
| --- | --- |
| `CAPTURED` | the only path that credits a wallet; writes the `WALLET_TOP_UP` transaction directly as `SETTLED` — the money genuinely arrived, there is no counterparty and nothing pending |
| `FAILED · PROVIDER_DECLINED` | authorisation refused; the default code when a provider refuses without giving one. No journal is opened, balance stays `0`, and the intent still records the failure so an operator can see it happened |
| `FAILED · CAPTURE_DECLINED` | capture refused after a successful authorisation — a distinct code on purpose: promised-then-not-taken is operationally different from never-promised |
| `REFUNDED` | a **reversal** of the top-up journal; the `WALLET_TOP_UP` transaction stays `SETTLED` and both journals remain |

**Refund authorisation.** `SYSTEM_ADMIN` / `UNION_ADMIN` only — the owning
organization's own admin is refused. If the provider rejects the refund the API answers
`422 BUSINESS_RULE_VIOLATION` and the intent stays `CAPTURED`: recording "refunded"
would make a second attempt fail as "already refunded". If the money has since been spent,
`422 INSUFFICIENT_BALANCE`.

**Error, authorisation and degraded-dependency states** are now a panel on the wallet
surface rather than prose, one row per real response:

| Code | When |
| --- | --- |
| `400 VALIDATION_FAILED` | `Idempotency-Key` missing or shorter than 8 characters — rejected at the gateway **and** again inside the service |
| `403 FORBIDDEN` | `AUDITOR` on any financial route (three-layer defence); or a non-buyer attempting `confirm-receipt` |
| `404 NOT_FOUND` | another organization's wallet or order — never `403`, which would confirm the record exists |
| `409 INVALID_STATE_TRANSITION` | transaction machine: a `DISPUTED` transaction cannot be settled |
| `422 BUSINESS_RULE_VIOLATION` | illegal **order** transition — `422` not `409`, because the request is well-formed and retrying will never help |
| `422 INSUFFICIENT_BALANCE` | hold or refund beyond available balance; `ck_wallet_balances` refuses it anyway |
| `503 UPSTREAM_UNAVAILABLE` | economic-service unreachable from the order saga. The Temporal activity retries with an idempotency key derived from the order id — never a timestamp or a random value — so a retry is a replay, not a second hold |

**Wallet races**, from `wallet-races.int-spec.ts`: two concurrent first requests get the
same wallet (the loser of the unique-index race re-reads rather than failing); a wallet
opened by a service command records `economic-service` as its author, not a blank and not
a fabricated user id; a zero or negative credit is refused with
`BUSINESS_RULE_VIOLATION` and posts nothing.

---

## 6. Verification statement

Verified over local HTTP in headless Chrome: all three checkpoint documents return HTTP 200,
render with **zero unresolved template holes** and no document-level horizontal overflow.
The portable font stack makes no unresolved local font request. The generated Design Component
runtime does emit transient SVG attribute diagnostics while raw `{{ ... }}` chart coordinates
are being substituted; the final DOM resolves those placeholders. A stale `funnel` glyph on
the offers header was corrected to `filter`. Contrast, the 13px mobile text floor and the
`--control-border` token from the previous checkpoint are unchanged and still hold on the new
wallet surface.

**Not verified, and not claimable:** no request was made against either running service.
Every field name, enum value and status code above was read from source at the baseline
commit — re-check them against the DTOs before building. Numbers shown in the design are
illustrative demo values chosen to be internally consistent (wallet ledger 1 150.4 M −
holds 310.4 M = available 840.0 M, matching the order's 298 M hold); they are not seeded
data from any environment.

---

## 7. Open questions and limitations recorded at this checkpoint

**Recorded, not designed.** Each of these needs a product rule rather than a reading of
existing code, so no design was produced for it:

1. **Mobile Economic / Marketplace surfaces do not exist.** The mobile screen covers fleet
   and maintenance only. Which wallet and order actions belong on a phone — and whether a
   field operator may confirm receipt at all, which is the one command that releases money
   — is a product decision, not something the API can answer. Not invented here.
2. **Q-08** — the commission rate. Still open, still no default anywhere. Every rate shown
   in any surface is labelled a sample requiring approval.
3. **Q-09** — what share of commission funds rewards. Rewards stay points-only.
4. **Q-13** — the reward level ladder. `RewardBalanceView.level` is `null`; the designs
   now say «تعریف‌نشده» everywhere, including the notification and organization panels
   where «نقره‌ای» had survived.
5. **Commission-rate simulation** (admin console) has no endpoint in economic-service. It
   is marked `PLANNED` rather than removed, because it is a documented governance
   requirement — but it is not a capability today.
6. **Supplier qualification, `sort=RATING`, inventory reservation, Document Service and
   Notification Service** remain `UNAVAILABLE` / deferred, unchanged.

**Tooling limitation.** The design environment here has read-only access to the
repository: it can read implementation, tests, contracts and ADRs at any ref, and it can
copy files in, but it has **no commit or push capability**. The artefacts below were
updated in the design project and are ready to be committed to `design/claude-design` —
no branch was created, nothing was merged, and no production code was touched.
