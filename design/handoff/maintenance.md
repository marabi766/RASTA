# Maintenance — Design Checkpoint & Implementation Handoff

## 1. Metadata

|                         |                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| Backend repository      | `marabi766/RASTA`                                                                                          |
| Backend baseline commit | `e4f9b1e7867bac701fba49caec8a1e76697981e7` (`e4f9b1e`), branch `main`                                      |
| Design source           | `design/source/RASTA-Web-Portal.dc.html`                                                                   |
| Date                    | 2026-08-29                                                                                                 |
| Design status           | **Approved.** Maintenance is `IMPLEMENTED IN BACKEND · READY FOR FRONTEND`. No production frontend exists. |
| Verification limitation | Final verification was manual, not an independent automated result. See §15.                               |

Related decisions: ADR-027 (due evaluation), ADR-028 (cost provenance and the economic
seam), ADR-029 (workshop access and object-level authorization).

## 2. Implemented backend surfaces represented

| Surface              | Owning code                                                            | Status                                                       |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| Maintenance request  | `src/maintenance/request.{controller,service}.ts`                      | IMPLEMENTED                                                  |
| Repair order         | `src/maintenance/repair-order.{controller,service}.ts`                 | IMPLEMENTED                                                  |
| Maintenance schedule | `src/maintenance/schedule.{controller,service}.ts`                     | IMPLEMENTED                                                  |
| Due schedules        | `src/maintenance/due.ts`, `due-scanner.ts`, `due-announcer.service.ts` | IMPLEMENTED (announcement via in-process scan, not Temporal) |

## 3. Routes and screens

| App route                | Screen (Persian)      | Source screen id | Status                                                                           |
| ------------------------ | --------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `/maintenance/[id]`      | جزئیات درخواست تعمیر  | `maintDetail`    | PARTIAL — request + repair order implemented; attachments and settlement are not |
| `/maintenance/schedules` | برنامه سرویس و سررسید | `schedules`      | IMPLEMENTED IN BACKEND · ready for frontend                                      |

Navigation: both live inside the existing ناوگان group in the left rail. The schedules
entry sits directly under «درخواست تعمیر». No new top-level domain was introduced.

## 4. API-to-UI mapping

### Maintenance requests

| UI                                                              | API                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Request header (title, type, severity, status, asset, reporter) | `GET /v1/maintenance-requests/:id`                                                                       |
| Request list / machine history                                  | `GET /v1/maintenance-requests?assetId=&status=&type=&severity=&scheduleId=&openOnly=&from=&to=` (cursor) |
| Raise planned work or a breakdown                               | `POST /v1/maintenance-requests`                                                                          |
| Lifecycle timeline                                              | request timestamps + repair-order timestamps on the detail response                                      |

### Workshop assignment

| UI                   | API                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| «ارجاع به تعمیرگاه»  | `POST /v1/maintenance-requests/:id/assign` → creates the repair order, publishes `WORKSHOP_ASSIGNED`               |
| Workshop card        | `workshopOrganizationId`, `workshopName` (snapshot at referral), `assignedAt`                                      |
| Qualification notice | `WorkshopDirectory` returns `{ permitted: true, verified: false }` — the UI says qualification was **not** checked |

### Repair-order lifecycle

| UI                   | API                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| «ورود به تعمیرگاه»   | `POST /v1/repair-orders/:id/start` → `MAINTENANCE_STARTED`                                                                                      |
| «پایان کار تعمیرگاه» | `POST /v1/repair-orders/:id/complete` (requires `workPerformed`; optional `returnedToServiceAt`) → `REPAIR_COMPLETED` + `MAINTENANCE_COMPLETED` |
| «لغو ارجاع»          | `POST /v1/repair-orders/:id/cancel` (reason required)                                                                                           |
| Referral list        | `GET /v1/repair-orders?maintenanceRequestId=&assetId=&workshopOrganizationId=&status=`                                                          |

### Parts, labour and cost lines

| UI                                                | API                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Cost table rows with category `PART`              | `POST /v1/repair-orders/:id/parts` — writes the part and its cost line in one transaction                                               |
| Rows with category `LABOUR`                       | `POST /v1/repair-orders/:id/labour` — hours × rate, rounded once                                                                        |
| Rows with `SERVICE` / `EXTERNAL_REPAIR` / `OTHER` | `POST /v1/repair-orders/:id/costs` — `PART` and `LABOUR` are rejected here by the DTO                                                   |
| Provenance column                                 | `partUsageId` / `laborEntryId` / both null = entered directly by `recordedBy`                                                           |
| Category breakdown + total                        | `partsCostMinor`, `labourCostMinor`, `otherCostMinor`, `totalCostMinor` — recomputed from the lines under a row lock, never incremented |

### Completion and approval

| UI                                            | API                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| «تأیید هزینه» (enabled only from `COMPLETED`) | `POST /v1/maintenance-requests/:id/approve`                                                            |
| Stale-total guard                             | `expectedTotalCostMinor` echoed from the screen; a mismatch is refused                                 |
| Result                                        | `MAINTENANCE_APPROVED` with a per-category `costBreakdown` — the only event that authorises settlement |
| «لغو درخواست»                                 | `POST /v1/maintenance-requests/:id/cancel` (reason required); impossible after approval                |

### Schedules

| UI                                    | API                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------- |
| Tab «همه برنامه‌ها»                   | `GET /v1/maintenance-schedules?assetId=&status=&maintenanceType=` (cursor) |
| Tab «فقط سررسیدشده»                   | `GET /v1/maintenance-schedules/due`                                        |
| Tab «شامل سررسیدنشده»                 | `GET /v1/maintenance-schedules/due?includeNotDue=true`                     |
| «ارزیابی در تاریخ»                    | `?at=<ISO-8601 UTC>`                                                       |
| Detail panel                          | `GET /v1/maintenance-schedules/:id`                                        |
| Create form                           | `POST /v1/maintenance-schedules`                                           |
| «ویرایش قاعده» and «لنگرگذاری دوباره» | `PATCH /v1/maintenance-schedules/:id`                                      |
| «توقف موقت» / «از سرگیری» / «بایگانی» | `POST /v1/maintenance-schedules/:id/status` (reason required)              |

Each due row also carries `meter.hourMeter`, `meter.odometer`, `meter.lastPeriodEnd`
and `openRequestId` (rendered as «درخواست باز: …»).

## 5. Lifecycle states and legal UI actions

**Maintenance request** — `OPEN → IN_PROGRESS → COMPLETED → APPROVED`; `CANCELLED`
reachable from the first three. `APPROVED` and `CANCELLED` are terminal.

| Status        | Actions the UI offers                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `OPEN`        | assign a workshop, cancel                                                                                |
| `IN_PROGRESS` | complete the repair order, cancel the referral, cancel the request                                       |
| `COMPLETED`   | approve (with `expectedTotalCostMinor`), cancel — cancelling from here is the owner _rejecting_ the work |
| `APPROVED`    | none; the screen states it authorised settlement and cannot be reopened                                  |
| `CANCELLED`   | none                                                                                                     |

**Repair order** — `OPEN → IN_PROGRESS → COMPLETED`; `CANCELLED` from `OPEN` or
`IN_PROGRESS`. One live referral per request. Cost may be recorded while `OPEN` or
`IN_PROGRESS` only. Costs recorded against a cancelled referral are kept.

Approval is disabled — not hidden — outside `COMPLETED`, with the reason stated next to
the button.

**Schedule** — `ACTIVE ⇄ PAUSED`, either to `ARCHIVED`, which is terminal and
uneditable. Resume is offered only on a `PAUSED` schedule.

## 6. Due states

Derived on every read from the rule, the meter and the clock (ADR-027). There is no
stored `due` column, and the UI says so on the screen: a scanner that has not run
delays announcements, never the list.

| State      | Meaning                    | Treatment                                             |
| ---------- | -------------------------- | ----------------------------------------------------- |
| `OVERDUE`  | past the due point         | danger token, negative remaining («−۱۵ ساعت»)         |
| `DUE_SOON` | inside the configured lead | warning token                                         |
| `NOT_DUE`  | not yet inside the lead    | success token; only visible with `includeNotDue=true` |

Inactive schedules (`PAUSED`, `ARCHIVED`) are not assessed at all and are shown with a
neutral token and no verdict.

## 7. Due triggers

`TIME` (days), `HOURS` (engine hours), `KILOMETRES` — any combination, at least one.

Every configured trigger is listed on its own line in the row, with its rule
(«هر ۲۵۰ ساعت · lead ۲۰») and its own state dot. When more than one is configured the
schedule is due on **whichever is reached first**; that trigger is marked
«← تعیین‌کننده» and its basis, due point and remaining amount fill the row's own
columns. Ranking is by state first (an overdue trigger always wins), then by declaration
order TIME → HOURS → KILOMETRES within a state — remaining amounts are never compared
across bases.

Due point is a Jalali date for `TIME` and a meter reading for `HOURS` / `KILOMETRES`;
the row labels which one it is showing.

## 8. Roles and permissions

| Role                                                                 | Maintenance                                                                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYSTEM_ADMIN`, `UNION_ADMIN`, `ORGANIZATION_ADMIN`, `FLEET_MANAGER` | full tenant scope: raise, assign, start, complete, record cost, approve, cancel, and all schedule writes                                                             |
| `OPERATOR`, `DRIVER`                                                 | report a breakdown on a machine in their own organization, and read **only** the requests they reported. No referral, no cost entry, no approval, no schedule writes |
| `WORKSHOP`                                                           | falls into the same narrowing and therefore sees nothing. Deferred, not stubbed (Q-25)                                                                               |
| Unknown role                                                         | least access — the rule is written as a narrowing, not a widening                                                                                                    |
| Service caller                                                       | treated as supervisor scope after `@AllowService`                                                                                                                    |

Tenant isolation is enforced independently of role. A record in another organization is
`404`, never `403` — a 403 would confirm the record exists.

## 9. Loading, empty, error and edge states

All nine are represented on the schedules surface, and the request surface carries its
own error/conflict panel.

| State                  | Representation                                                                   | Source                           |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------- |
| Loading                | row skeleton; no verdict is guessed before the response lands                    | pending request                  |
| Empty list             | invitation to define the first schedule, with no suggested interval              | `items: []` on the list endpoint |
| No due schedules       | a positive statement, not a blank panel                                          | `items: []` on `/due`            |
| Validation error       | message under the offending field, matching the Zod `path`                       | `422`                            |
| Forbidden              | controls disabled with a stated reason, not hidden                               | `403` from the `@Roles` guard    |
| Cross-tenant not found | «پیدا نشد», explicitly never 403                                                 | `404`                            |
| Stale data             | timestamped evaluation banner with «ارزیابی دوباره»                              | client-side re-fetch             |
| Inactive schedule      | greyed `PAUSED` row: no verdict, pause reason shown                              | `status`                         |
| Missing meter          | «بدون قرائت» with an explicit note that the usage trigger was assessed at `0.00` | `meter.lastPeriodEnd: null`      |

Request-surface conflicts: duplicate open request `422`, invalid or early approval
`409`, stale total `422`, repeated terminal action `409`, forbidden role `403`,
cross-tenant `404`.

## 10. Validation behaviour

- At least one of `intervalDays`, `intervalHours`, `intervalKilometres` — on create and
  on edit. An edit that would clear the last remaining interval is refused
  (`SCHEDULE_WITHOUT_INTERVAL`).
- Each lead must be smaller than the interval it warns about (`leadDays` is validated in
  the DTO; a lead as long as the interval means permanent "due soon").
- Intervals are nullable and removable via `PATCH` with `null`, provided one survives.
- **No platform-supplied intervals.** Every value comes from the organization. The only
  fallback is the time lead, which falls back to service configuration clamped below the
  interval.
- Quantities cross the wire as decimal **strings** (two decimals; three for part
  quantities), never JSON floats.
- Duplicate schedule title on one machine → `DUPLICATE_SCHEDULE_TITLE`.
- Any edit clears `dueAnnouncedAt`, re-arming the announcement, and so does resuming a
  paused schedule. The UI states this.
- **Meter replacement is manual.** The usage meter never moves backwards and the
  platform does not detect a swapped instrument. The supported repair is an explicit
  re-anchor with `lastServicedHourMeter` / `lastServicedOdometer`; usage history is not
  rewritten. The UI presents this as a deliberate action with its own warning card.
- Corrective requests must state a severity; preventive requests must not. Severity is
  recorded and published but is wired to no automatic behaviour.

## 11. Cross-domain effects

- `MAINTENANCE_STARTED` → asset-service moves the machine to `IN_MAINTENANCE`;
  fleet-service sets `asset_ref.inMaintenance` and blocks new driver assignment.
- `MAINTENANCE_COMPLETED` → the machine returns to service and the dispatch block clears.
- Both consumers act on the event; maintenance-service issues no command.
- `assetId` is load-bearing on every published event — the asset timeline projector
  silently skips an event without one.
- `USAGE_RECORDED` from fleet-service feeds the meter read model, which is what makes a
  usage-based schedule evaluable. The meter is monotonic by design.
- Maintenance owns none of: asset records, fleet usage records, supplier profiles,
  inventory, or money movement.

## 12. Accessibility and responsive behaviour

- Breakpoints reuse the portal's existing rules: the split panels collapse to one column
  at 1279px, card grids step 3 → 2 → 1, and the schedules table keeps a 1080px floor
  inside a horizontal-scroll wrapper. A forced narrow-layout simulation produced no
  overflow outside that wrapper and no document-level horizontal scroll.
- A global `:focus-visible` outline (2px primary, 2px offset) was added during this pass;
  the file previously relied on browser defaults.
- Touch targets: no visible control under 36px; primary form actions at 44px.
- Every status is carried by a text code as well as a colour — `OVERDUE`, `DUE_SOON`,
  `NOT_DUE`, `IN_PROGRESS`, `PART`, `LABOUR` and so on are rendered as text.
- Labels sit with their fields; an error message sits directly under the field it
  belongs to, matching the API's `path`.
- Colour pairs come from the existing token set (`*-soft` background with `*-tx`
  foreground) in both light and dark themes.

## 13. Deferred and unsupported

| Item                                           | Note                                                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-24                                           | The documented "assigned assets only" rule for `OPERATOR` is unresolved; the current narrowing is deliberately different, not a partial implementation |
| Q-25                                           | Workshop access model undecided; no workshop portal, no messaging, no cross-tenant access                                                              |
| D-011                                          | Schedule changes emit no audit event; the reason is appended to the schedule notes instead                                                             |
| D-012                                          | A replaced usage meter is not re-anchored automatically                                                                                                |
| Workshop verification / ratings                | supplier-service does not exist; every referral records `verified: false`                                                                              |
| Attachments                                    | document-service does not exist                                                                                                                        |
| Settlement, wallet, ledger, commission         | economic-service does not exist; `MAINTENANCE_APPROVED` is the gate and carries no financial rules                                                     |
| Inventory reservation / stock deduction        | inventory-service does not exist; a part records consumption and a reference only                                                                      |
| Marketplace ordering                           | not represented as implemented anywhere                                                                                                                |
| Temporal-driven due scan                       | the architectural decision stands but is unimplemented; today an in-process guarded scan announces                                                     |
| Automatic request creation from a due schedule | the scan announces; a human decides                                                                                                                    |

## 14. Frontend implementation notes

- Persian and Jalali formatting is **presentation only**. Every timestamp sent to or
  received from the API is ISO-8601 in UTC.
- Money is a **string in minor units** beside a separate `currency` field. Never parse it
  into a JavaScript number — rial amounts exceed the safe integer range.
- Quantities are decimal strings for the same reason.
- Cursor pagination throughout. On `/due`, the not-due filter is applied after
  assessment, so a page can return few rows while `hasMore` is still true — page on the
  cursor, not on row count.
- Due state must be read from the response on every load. Never cache a verdict.
- **No production frontend has been implemented.** This checkpoint is specification.

## 15. Verification statement

- The automated verifier **did not return a report** for the final pass.
- Final verification was therefore performed **manually**.
- Method: DOM probes (rendered row counts, state-code occurrences, control heights),
  a forced narrow-layout simulation measuring element overflow, and console inspection.
- One real defect was found and fixed during that pass: a malformed data literal broke
  the logic class, which the runtime reported as a failed evaluation with unresolved
  template holes. After the fix, **no console errors or warnings were observed**.
- This is **not an independent automated verification result**.
- Accessibility must be tested again during production frontend implementation, with a
  real screen reader, real keyboard traversal and measured contrast ratios.
