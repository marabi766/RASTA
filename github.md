repo: marabi766/RASTA
branch: main
path: (whole repo — docs/ + services/)
design branch: design/claude-design (design artefacts belong here; no push capability from this environment — see § Tooling)

## Last sync

date: 2026-08-31T00:00:00Z
read: main@69dbcc3 (resolved 69dbcc31eed8) — 78 commits after baseline e4f9b1e7867bac701fba49caec8a1e76697981e7, 9 after the previous checkpoint
previous baseline: read of main at tree b7513c30e9a2 (2026-08-30)

### Updated in this project

- Delta since the previous checkpoint is small and touches no marketplace/economic **contract**: `docs/25-project-progress.md` + `planning/backlog.json` (new governance reporting), `docs/14-testing-strategy.md`, `ledger.repository.ts` (create-and-catch replaced by `ON CONFLICT DO NOTHING`, since a unique violation inside an interactive transaction aborts it), and two new economic suites — `payment-provider-contract.int-spec.ts` and `wallet-races.int-spec.ts`. The order and offer DTOs, both state machines, pricing and both `access.ts` files were re-read at `69dbcc3` and are unchanged from what the previous checkpoint was grounded on.
- **Portal — stale `PLANNED` replaced where the capability is real:** the maintenance settlement step said «economic-service وجود ندارد — PLANNED». It exists and consumes `MAINTENANCE_APPROVED` (`consumers/settlement-authority.consumer.ts`, `events/consumed.ts`), recording a settleable obligation and moving no money — the step now says that.
- **Portal — ADR-043 window corrected.** The `AWAITING_RECEIPT_CONFIRMATION` timeline row cited «پنجره تحویل ۷ روز»; on that state the applicable window is `MARKETPLACE_RECEIPT_WINDOW_DAYS` (default 3). The 7-day figure is the fulfilment window, measured from `CONFIRMED`.
- **Portal — invented reward level removed** from the notification card and the organization facts panel («سطح: نقره‌ای» → «تعریف‌نشده»). `RewardBalanceView.level` is `null` until a ladder is configured (Q-13), and rewards are granted to a **user**, not an organization.
- **Portal — new on the wallet surface:** payment-provider disclosure read from `GET /v1/wallets/provider` (`provider: mock`, `simulated: true`, the service's own notice); the payment-intent lifecycle with the real failure codes `PROVIDER_DECLINED` and `CAPTURE_DECLINED`; refund rules (platform roles only, `422` and intent stays `CAPTURED` when the provider refuses, `422 INSUFFICIENT_BALANCE` when the money is spent); and an eight-row catalogue of real API states — `400` missing/short `Idempotency-Key`, `403` AUDITOR and non-buyer receipt confirmation, `404`-not-`403` cross-tenant, `409 INVALID_STATE_TRANSITION`, `422 BUSINESS_RULE_VIOLATION`, `422 INSUFFICIENT_BALANCE`, `503 UPSTREAM_UNAVAILABLE` with order-derived idempotency keys.
- **Admin console audited for the first time** (it predates the provenance discipline and was drawn before economic-service existed). Removed: a 1.8 % «میانگین وزنی» commission KPI and a `۴۰۱۰ درآمد کارمزد ۶۹۲ م` trial-balance balance (no rule is configured and there is no default — Q-08); a settlement journal leg «درآمد کارمزد (۲٪)»; a `۹۹۱۰ حساب انتظامی — مغایرت درگاه` suspense account and a «مغایرت درگاه پرداخت» reversal (there is no gateway to disagree with — the real reversal case is a refunded top-up, now shown as `۲۰۱۰ / ۱۰۱۰`); «economic-service — ساخته نشده» in the service health list; a two-role approval rule for rate changes (code requires `SYSTEM_ADMIN` alone, and refuses `UNION_ADMIN`); and a rate simulator presented as a working feature (marked `PLANNED` — no endpoint exists). The supplier-qualification screen now carries an explicit `PLANNED` / `UNAVAILABLE` banner.
- **Design System V2:** the marketplace product cards showed a ★ rating per supplier and the RFQ table had «عملکرد» and «امتیاز» columns. Nothing produces those numbers; the columns were removed and the cards now read «صلاحیت: UNAVAILABLE». The admin users table no longer marks a `SUPPLIER` «احرازشده» (no service verifies suppliers) and an organization path no longer reads «پیمانکار · تأییدشده».
- `design/handoff/commerce.md` gained § 5 (payment abstraction and state catalogue) and § 7 (open questions + the read-only tooling limitation); README § "backend baseline" rebased onto `69dbcc3`; checkpoint mirror refreshed.

### Tooling

This environment can read the repository at any ref and copy files in; it has **no commit or push capability**. The artefacts listed under "Files" are updated in the design project and ready to be committed to `design/claude-design`. No branch was created, nothing was merged into `main`, and no production code was modified.

## Sync history

- date: 2026-08-30T13:19:43Z · tree b7513c30e9a2 · economic + marketplace services appeared; three commerce surfaces re-grounded, wallet screen built, `--control-border` declared in DS V2.
- date: 2026-08-29T05:30:00Z · baseline e4f9b1e7867b · mobile-responsive audit and rebuild; 13px text floor and the `--control-border` token portal-wide.
- 2026-08-28T19:58:22Z · commit e4f9b1e7867b · maintenance-service audit; maintenance + schedules screens added.
- 2026-08-28T11:38Z · tree 99ee98ad23e0 · fleet/asset/identity/organization audit; maintenance did not exist yet.

## Screen map
| Screen | Built from |
| --- | --- |
| راننده و تخصیص (drivers) | services/fleet-service/src/fleet/{driver.controller,driver-lifecycle,dto,access,constraints}.ts |
| ثبت کارکرد (usage) | services/fleet-service/src/fleet/{fleet.controller,usage.service,dto}.ts |
| تحلیل ناوگان (fleetAnalysis) | services/fleet-service/src/fleet/{availability.service,dto}.ts |
| ثبت دارایی (assetNew) | services/asset-service/** · PROJECT_MEMORY.md §15 |
| سازمان و اعضا (organizations) | services/organization-service/** · services/identity-service/** |
| جزئیات درخواست تعمیر (maintDetail) | services/maintenance-service/src/maintenance/{lifecycle,access,due,events,dto,views,request.controller,repair-order.controller,schedule.controller}.ts · ADR-027/028/029 · economic-service/src/events/consumed.ts (settlement step) |
| برنامه سرویس و سررسید (schedules) | services/maintenance-service/src/maintenance/{schedule.controller,schedule.service,due,dto,views}.ts · ADR-027 |
| مقایسه پیشنهادها (offers) | services/marketplace-service/src/offer/{dto,catalogue.controller}.ts · src/order/pricing.ts · src/access/access.ts · ADR-041/042 |
| جزئیات سفارش (orderDetail) | services/marketplace-service/src/order/{dto,state-machine,order.controller}.ts · src/access/access.ts · src/economic/economic.client.ts · ADR-037/038/039/040/041/043 |
| کیف پول و تسویه (wallet) | services/economic-service/src/{wallet,transaction,ledger,reward,commission,payment}/**.ts · src/access/access.ts · test/{payment-provider-contract,wallet-races}.int-spec.ts · ADR-022/023/024/032/033/034 |
| تأمین · عمران · قرارداد · اعلان (demands, suppliers, projects, tenders, contracts, notifications) | PLANNED — no service exists; docs/17-mvp-scope.md, docs/16-ui-architecture.md |
| نسخه موبایل (mobile) | services/fleet-service/src/fleet/**.ts · services/maintenance-service/src/maintenance/**.ts · docs/24-open-questions.md Q-11/Q-24/Q-25 — **no Economic or Marketplace mobile surface exists** (open question, § 7 of the commerce handoff) |
| Admin Console — دفتر کل و تراز (ledger) | services/economic-service/src/ledger/{ledger.repository,journal,accounts}.ts · src/access/access.ts (platform-scope trial balance) · docs/10 §10.3 |
| Admin Console — قواعد پیکربندی‌پذیر (rules) | services/economic-service/src/commission/{dto,rule-engine}.ts · src/reward/{dto,rule-engine}.ts · src/access/access.ts (RULE_ADMIN_ROLES) · ADR-023/033 · docs/24 Q-08/Q-09 |
| Admin Console — احراز صلاحیت (qualify) | PLANNED — supplier-service does not exist; ADR-041 |
| Design System V2 | docs/16-ui-architecture.md §16.4–16.9 · commerce sample screens re-grounded against marketplace-service + economic-service |
