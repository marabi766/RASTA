# Mobile — Design Checkpoint & Implementation Handoff

## 1. Baselines inspected

|                                 |                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Backend repository              | `marabi766/RASTA`                                                                            |
| Backend baseline commit         | `e4f9b1e7867bac701fba49caec8a1e76697981e7` (`e4f9b1e`) — the commit this design is bound to  |
| Repository state also read      | `main` at 2026-08-29T05:12Z — 11 commits ahead of the baseline                               |
| Approved design branch          | `design/claude-design`                                                                       |
| Design checkpoint at task start | `c7685099bbc1420845c95388b9147c60ba99fcce`                                                   |
| Design source                   | `design/source/RASTA-Web-Portal.dc.html`, screen id `mobile`                                 |
| Date                            | 2026-08-29                                                                                   |
| Design status                   | Specification. **No production mobile frontend, no PWA, no service worker, no push exists.** |

Files read in full for this pass: `AGENTS.md`, `PROJECT_MEMORY.md`, `design/README.md`,
`design/handoff/maintenance.md`, `design/source/RASTA-Web-Portal.dc.html`,
`services/fleet-service/src/fleet/{dto,usage.service,access,fleet.controller,driver.controller,assignment.controller}.ts`,
`services/maintenance-service/src/maintenance/dto.ts`, plus the maintenance controller/lifecycle/due
files already mapped in `handoff/maintenance.md`, and `docs/24-open-questions.md` (Q-11, Q-24, Q-25).

**Finding about the newer repository state.** Between the pinned baseline and `main`, a complete
`services/economic-service` (ledger, wallet, transaction, settlement, commission, reward, mock
payment provider) and ADR-030…ADR-034 were added. **This design deliberately does not represent
economic or marketplace as implemented** — the task forbids it and the checkpoint is bound to
`e4f9b1e`. Every economic and marketplace surface remains `PLANNED`. Re-grounding the economic
domain against the new service is a separate, approval-gated task.

## 2. Personas and role boundaries

Read from `fleet-service/src/fleet/access.ts` and `maintenance-service/src/maintenance/access.ts`.
The rule in both services is written as a **narrowing**, so an unknown role gets least access.

| Role                                | On mobile they can                                                                                                                                                         | They must never see                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OPERATOR`                          | record usage for the machine whose **active assignment is their own**, report a breakdown on a machine in their own organization, read **only the requests they reported** | referral, cost entry, approval, schedule writes. A machine they do not hold answers `404`, never `403` |
| `DRIVER`                            | the same scope; usage lists narrow to their own driver record (no driver record → empty list, not an error)                                                                | any supervisory action                                                                                 |
| `FLEET_MANAGER`                     | whole tenant: assign workshop, start/complete repair, record parts/labour/cost, approve, all schedule writes                                                               | anything outside the tenant; approval before `COMPLETED` (disabled with the reason stated, not hidden) |
| `ORGANIZATION_ADMIN`, `UNION_ADMIN` | the supervisory scope plus tenant administration                                                                                                                           | cross-tenant records — always `404`                                                                    |
| `WORKSHOP`, unknown role            | least access; narrowed to their own driver record, which they do not have                                                                                                  | everything else. No workshop portal, no messaging (Q-25 open)                                          |

Q-24 (the documented "assigned assets only" rule for `OPERATOR`) and Q-25 (workshop access model)
are **left unresolved** in this design, as instructed. The current narrowing is deliberately
different from Q-24's wording, not a partial implementation of it.

## 3. Mobile routes and screens

No new information architecture. The mobile experience is the **responsive form of the existing
portal routes** — same routes, same rail, transformed layout.

| App route                               | Mobile screen                                                   | Status                                                                           |
| --------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/login` → OIDC, `/switch-organization` | ورود و بافت سازمان                                              | IMPLEMENTED (identity + organization)                                            |
| `/`                                     | خانه اپراتور — one primary action                               | IMPLEMENTED (composed from fleet + maintenance reads)                            |
| `/assets`                               | فهرست دستگاه‌ها — search, cursor paging                         | IMPLEMENTED                                                                      |
| `/assets/[id]`                          | جزئیات دستگاه — state, assignment, maintenance, meter, blockers | IMPLEMENTED                                                                      |
| `/usage/new`                            | ثبت کارکرد                                                      | IMPLEMENTED                                                                      |
| `/maintenance/new`                      | ثبت خرابی                                                       | IMPLEMENTED                                                                      |
| `/maintenance` (own scope)              | درخواست‌های من                                                  | IMPLEMENTED                                                                      |
| `/maintenance/schedules`                | سررسید سرویس — cards, not the table                             | IMPLEMENTED IN BACKEND · ready for frontend                                      |
| `/maintenance/[id]` (manager)           | اقدام‌های مدیر ناوگان                                           | PARTIAL — request + repair order implemented; attachments and settlement are not |
| —                                       | صف آفلاین و PWA                                                 | **PLANNED · NOT IMPLEMENTED**                                                    |
| —                                       | تأیید دریافت سفارش                                              | **PLANNED · marketplace + economic**                                             |

The design source renders each of these as a 390 CSS-px frame on the `mobile` screen; the two
planned screens sit in a visually separated section with dashed bezels and a `PLANNED` chip.

## 4. API-to-UI mapping

### Identity and organization context

| UI                                  | API                                                              |
| ----------------------------------- | ---------------------------------------------------------------- |
| «ورود با حساب سازمانی»              | Keycloak OIDC redirect — no password is collected in the app     |
| Active organization card, role chip | session/organization context; membership list for «تغییر سازمان» |
| «نشست منقضی شد»                     | `401` from any call; form content is preserved across re-login   |

### Asset lookup and detail

| UI                                                | API                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset list + search + cursor paging               | asset-service list; scope is always the active organization                                                                                          |
| Operational state, blockers with `code` + `owner` | `GET /v1/fleet/availability` — `blockers[].code` ∈ `ASSET_STATUS`, `IN_MAINTENANCE`, `DISPATCH_BLOCKED`, `ACTIVE_ASSIGNMENT`, `DECLARED_UNAVAILABLE` |
| Current assignment                                | `currentAssignment` on the same response / `GET /v1/assignments?assetId=&active=true`                                                                |
| Maintenance state                                 | `GET /v1/maintenance-requests?assetId=&openOnly=true`                                                                                                |
| Due state                                         | `GET /v1/maintenance-schedules/due?assetId=`                                                                                                         |
| Meter                                             | `meter.hourMeter` / `meter.odometer` / `meter.lastPeriodEnd` on the due view                                                                         |

### Usage recording — `POST /v1/usage-records`

Fields exactly as `recordUsageSchema` (`.strict()`, unknown field **rejected**):

| UI field                       | API field                  | Rule                                                                                                                            |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| بازه — آغاز / پایان            | `periodStart`, `periodEnd` | both required, ISO-8601 UTC; end > start; end may not be in the future beyond a 5-minute clock-skew tolerance (`FUTURE_PERIOD`) |
| ساعت کارکرد                    | `hours`                    | decimal **string**, ≤ 2 decimals, ≤ 8 integer digits                                                                            |
| کیلومتر                        | `kilometres`               | decimal string, ≤ 2 decimals, ≤ 10 integer digits                                                                               |
| قرائت کنتور ساعت / کیلومترشمار | `hourMeter`, `odometer`    | end-of-period readings, decimal strings                                                                                         |
| دستگاه                         | `assetId`                  | required                                                                                                                        |
| راننده                         | `driverId`                 | optional; for `SELF` scope it must be the caller's own driver record                                                            |
| منبع                           | `source`                   | `MANUAL` (default) · `TELEMATICS` · `IMPORTED`                                                                                  |
| یادداشت                        | `notes`                    | optional, ≤ 1000                                                                                                                |
| کلید تکرارناپذیری              | `clientReference`          | optional, 8–128 chars. **The mobile design always sends one.**                                                                  |

At least one of `hours` / `kilometres` is required — the error's Zod `path` is `hours`, and the
message renders under that field. Reads: `GET /v1/usage-records` (cursor), `GET /v1/usage-records/:id`.

### Breakdown reporting — `POST /v1/maintenance-requests`

`assetId`, `type: 'CORRECTIVE'`, `title` (2–200), `description?` (≤2000), `severity` **required for
`CORRECTIVE`** and forbidden for `PREVENTIVE`, `outOfServiceAt?`, `dueDate?`, `reportedAt?`.
Severity values are exactly `LOW · MEDIUM · HIGH · CRITICAL`. Severity is recorded and published
and **wired to no automatic behaviour** — triage is human.

### Maintenance request tracking, schedules, manager actions

Unchanged from `handoff/maintenance.md` §4; the mobile screens consume the same endpoints. Request
lifecycle `OPEN → IN_PROGRESS → COMPLETED → APPROVED` (+ `CANCELLED`); repair order
`OPEN → IN_PROGRESS → COMPLETED` (+ `CANCELLED`); approval carries `expectedTotalCostMinor`.

## 5. Implemented versus planned

**Implemented and API-backed (section ۱ of the screen).** Session and organization context,
organization switching, asset lookup and detail with attributed blockers, usage recording with
server-side idempotency, breakdown reporting with duplicate-open-request protection, own-scope
request tracking, schedules and derived due state, and the manager actions above.

**Planned, visually separated (section ۲, dashed bezels).** Service worker, installed PWA, local
queue, automatic background retry, conflict resolution after reconnection, push notification,
camera/attachment upload (`document-service`), workshop portal and messaging, inventory
reservation, marketplace ordering, wallet/settlement/economic.

Nothing in section ۱ claims a capability the baseline does not have. The previous mobile mockups
claimed several — see §14.

## 6. Responsive behaviour

Rules live in the source's single `<style>` block and are shared with the desktop portal:

- **≤1023px** — the left rail becomes a sticky horizontal strip of 44px-minimum chips inside its own
  labelled horizontal scroll region; rail group labels and the rail footer are hidden; the top-bar
  search is hidden.
- **≤1279px** — split and two-column grids collapse to one column; three-column grids step to two.
- **≤767px** — `kpi4`, `three` and `cards3` grids become single-column; the organization chip in the
  top bar is hidden (the per-screen organization strip carries that context instead).
- Every phone frame in the spec is `width:390px; max-width:100%`, so it shrinks rather than
  overflowing on a 360px viewport.
- The desktop schedules **table** keeps its 1080px floor inside an explicitly labelled horizontal
  scroll wrapper. At mobile width the same data is a **card + disclosure** pattern
  (سررسید سرویس), never the table.

## 7. Mobile navigation

- Bottom tab bar with four destinations (خانه · دستگاه‌ها · کارکرد · تعمیرها); each tab is ≥44px
  and its bottom padding adds `env(safe-area-inset-bottom)`.
- A badge appears only where there is a real count; there is no empty badge shell.
- Every screen carries a back affordance and the **organization + role strip** directly under the
  header, so tenant context is visible during every mutation.
- No hover-only affordance, and no essential information inside a tooltip.

## 8. Forms and validation

- Label sits with its field; the API field name is shown beside the label in an LTR monospace
  island (`periodStart`, `clientReference`) so an engineer can map screen to DTO.
- The error message renders **under the field named by the Zod `path`**, plus a summary at the top
  of the form for screen-reader users.
- Primary action is 48px at the end of the flow — **not** a fixed sticky bar, so the software
  keyboard cannot cover it.
- Destructive/terminal actions are separated from the primary progression by a spacer and use an
  outline-danger treatment, never the primary fill.
- Numeric fields are strings end to end. The UI never parses money or quantity into a JS number.
- Jalali dates and Persian digits are **presentation only**; the wire is ISO-8601 UTC.

## 9. Network and offline semantics

**Implemented today.** Safe idempotent retry via `clientReference`: a resubmission returns the
original record and does **not** publish a second `USAGE_RECORDED` (so maintenance schedules never
double-count hours). A concurrent race is resolved by the unique index — the loser reads back the
winner's row instead of reporting a conflict. Network failure is an **explicit error with a manual
retry**; the form keeps what was typed.

**Planned, labelled `PLANNED` on every surface.** Local queue, automatic background retry, service
worker, installed PWA, conflict resolution after reconnection, push notification.

The design never tells the user their work is "saved" when it is not.

## 10. Error and edge states

All sixteen are represented on the mobile screen, each with the API condition that produces it:
loading (skeleton, no guessed verdict) · empty (`items: []`) · network unavailable · timeout ·
session expired (`401`) · forbidden (`403`, control disabled with a stated reason) · not found /
cross-tenant (`404`, never `403`) · validation error (`422` with Zod `path`) · duplicate open
request (`422`) · idempotent retry (original record) · stale evaluation (re-evaluate banner) ·
state-transition conflict (`409`) · stale total (`422`, `expectedTotalCostMinor`) · missing meter
(`meter.lastPeriodEnd: null`, usage trigger assessed at `0.00`) · paused/archived schedule (no
verdict, reason shown) · partial data and very long content.

## 11. Accessibility results

Measured on the light theme with the WCAG contrast formula (dark-theme pairs also measured):

| Pair                                         | Ratio       | Verdict                                                                                                                                                                                                                   |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tx` on `--surf`                           | 17.74       | pass                                                                                                                                                                                                                      |
| `--tx2` on `--surf`                          | 5.94        | pass                                                                                                                                                                                                                      |
| `--tx3` on `--surf`                          | 4.67        | pass                                                                                                                                                                                                                      |
| `--tx2` on `--sunken`                        | 5.26        | pass                                                                                                                                                                                                                      |
| `--tx3` on `--sunken`                        | **4.13**    | **fails AA for small text — replaced with `--tx2` on every sunken panel in the mobile screens**                                                                                                                           |
| `--pri-tx` / `--pri-soft`                    | 7.47        | pass                                                                                                                                                                                                                      |
| `--ok-tx` / `--ok-soft`                      | 6.70        | pass                                                                                                                                                                                                                      |
| `--warn-tx` / `--warn-soft`                  | 6.16        | pass                                                                                                                                                                                                                      |
| `--dgr-tx` / `--dgr-soft`                    | 7.55        | pass                                                                                                                                                                                                                      |
| `--info-tx` / `--info-soft`                  | 7.47        | pass                                                                                                                                                                                                                      |
| white on `--pri` (primary button)            | 6.12        | pass                                                                                                                                                                                                                      |
| white on `--dgr` (report-breakdown button)   | 6.76        | pass                                                                                                                                                                                                                      |
| focus ring `--pri` on `--surf`               | 6.12        | pass (≥3:1 non-text)                                                                                                                                                                                                      |
| **`--bd2` as a control border on `--surf`**  | **1.53**    | **fails WCAG 1.4.11 (3:1 non-text).** Secondary-button and input borders inside the mobile screens were moved to `--tx3` (4.67). The **global `--bd2` token is unchanged** — changing a global token needs approval (§16) |
| dark `--tx2` / `--surf` · `--tx3` / `--surf` | 7.64 · 5.28 | pass                                                                                                                                                                                                                      |
| dark `--warn-tx` / `--warn-soft`             | 8.57        | pass                                                                                                                                                                                                                      |

Other measured results (DOM probes at a real 360px viewport):

- **Touch targets** — every button inside the mobile frames measures **≥44px** (12 of 12); primary
  actions 48px. No control under 44px anywhere on the mobile surface.
- **Type size** — the smallest rendered text inside the mobile frames is now **12px** (was 9px).
  294 text nodes measured. Body copy 12–14px. Production floor recommended at 13px (§14 B-1).
- **Status is never colour-only** — `OVERDUE`, `DUE_SOON`, `NOT_DUE`, `OPEN`, `IN_PROGRESS`,
  `APPROVED`, `PART`, `LABOUR`, `CORRECTIVE`, severities and blocker codes all render as text.
- **RTL** — layout is `dir="rtl"`; identifiers, amounts, API enums and field names sit in explicit
  `dir="ltr"` islands with `overflow-wrap:anywhere`, so a long identifier wraps instead of
  overflowing (this fixed two real overflows found during the pass).
- **Focus** — a global `:focus-visible` outline (2px `--pri`, 2px offset) applies to every control.
- **Safe area** — bottom action bars and the tab bar add `env(safe-area-inset-bottom)`.

**Not verified, and must be tested during implementation:** real screen-reader output (names,
roles, error association, landmark and heading order), full keyboard traversal and focus return
from bottom sheets and dialogs, reduced-motion behaviour, and 200% browser zoom on a real device.
The design specifies these; a specification cannot prove them.

## 12. Viewport verification

Method: the checkpoint was served over HTTP and loaded inside an iframe whose width was set so that
`document.documentElement.clientWidth` equalled **exactly** the target CSS width. This is a real CSS
viewport for the document — media queries evaluated against it — measured with DOM probes.

| Width | `clientWidth` | Document horizontal overflow | Unguarded overflowing elements |
| ----- | ------------- | ---------------------------- | ------------------------------ |
| 360px | 360           | **0**                        | none                           |
| 390px | 390           | **0**                        | none                           |
| 430px | 430           | **0**                        | none                           |
| 768px | 768           | **0**                        | none                           |

Every element wider than the viewport was inside an ancestor with `overflow-x: auto` (the rail strip
and the labelled table wrapper). Two genuine overflows were found and fixed during the pass: the
`422 · expectedTotalCostMinor` monospace string and the long LTR enum run in the rules table.

**Limitations — stated rather than glossed.** This is a real viewport but not a real device: no
browser chrome, no software keyboard, no device pixel ratio, no touch. Portrait/landscape, 200%
browser zoom, OS text-size increase and safe-area behaviour were **not** measured — the harness
cannot produce them. The image exports in `screenshots/mobile/` are captures of the 360/390/430px
mobile frames themselves; the available tooling **cannot export an image of a nested viewport**, so
there is no 768px screenshot — 768 is evidenced by the measurements above, not by an image. **No
device verification is claimed.**

## 13. Deferred capabilities

Everything in `handoff/maintenance.md` §13 still stands, plus: production mobile frontend, installed
PWA, service worker, background sync, persistent offline queue, push notification, camera and file
upload, `document-service`, workshop portal and messaging, inventory reservation, marketplace,
economic settlement, wallet and payment, Temporal-driven due scan, automatic request creation from a
due schedule, automatic meter-replacement detection. Q-11's temporary rule is unchanged: a
three-day confirmation window, **no automatic confirmation**, and no settlement merely because the
window expired.

## 14. Known limitations

- **A-1 (fixed).** The previous mobile template referenced data the logic class no longer provided
  (`mobilePersonas`, `mobileUsage`, `mobileDue`, …). The screen rendered with unresolved template
  holes. All fifteen data sets are now defined and the screen renders with **zero** unresolved holes.
- **A-2 (fixed).** The usage screen presented a **local offline queue, automatic background sync,
  approved/needs-review usage statuses, an 18-hour daily cap, a monotonic-meter rejection and
  automatic outlier flagging**. None exist in `fleet-service`. Replaced with the real DTO,
  the real refusals, and server-side idempotency.
- **A-3 (fixed).** The previous mobile mockups showed reward points, voice-to-text, functional
  camera upload and an offline-queued photo — none exist. Removed or marked `PLANNED`.
- **A-4 (fixed).** A missing container close nested the `PLANNED` section inside a column of the
  implemented grid, squeezing two frames to 103px. Markup is now balanced (depth 0).
- **A-5 (fixed).** The previous checkpoint's README claimed `--tx3` had been darkened past AA, but
  the exported source still carried `--tx3:#8A9896` (2.99:1). This export carries `#697775` (4.67:1).
- **A-6 (open, approval needed).** Global `--bd2` (#C9D3D1) is 1.53:1 on white and fails WCAG
  1.4.11 wherever it draws a control boundary. Fixed locally on the mobile screens; the global token
  decision is deferred.
- **B-1 (recommended).** In-frame type now floors at 12px. The design system's own field-conditions
  rule asks for 13px body text; raising the global mobile floor to 13px is a type-scale change and
  is left for approval.
- **B-2 (recommended).** The rail's horizontal scroll strip at ≤1023px is a scroll region without a
  visible label. It is navigation, not data, so it is acceptable — but a visible affordance would
  be better.
- **C-1 (optional).** Frames are drawn at a fixed 648px height; a real device height (844px) would
  show less internal scrolling in the spec.
- The frames are a **specification rendering**, not a running application: nothing is interactive,
  and no state machine runs behind the screens.

## 15. Frontend-readiness verdict

**Ready to implement for the identity/organization, asset, usage, breakdown, own-scope request
tracking and schedule/due surfaces** — every field, enum, refusal and role boundary on those
screens is taken from the baseline DTOs and access rules, and the responsive layout is measured at
360/390/430/768 with no document overflow.

**Not ready, and must not be built from this document:** anything in the `PLANNED` section. There is
no offline capability, no attachment, no workshop portal, no marketplace and no settlement to build
against. Accessibility must be re-tested on real devices with a real screen reader before release.
