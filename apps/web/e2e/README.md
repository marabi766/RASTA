# Portal browser tests (`apps/web/e2e`)

Playwright specs for the portal. They come in two layers, and the difference
matters for what they may assume.

## Visitor checks — need only the portal

`login`, the visitor blocks of `maintenance`, and similar. They start the portal
and nothing else, so they run anywhere and any number of times at once.

## Live-stack scenarios — need the whole stack, and **one run per stack**

Anything that signs in (`installLiveSession`) and writes or reads real records
runs only when `WEB_LIVE_STACK_E2E=true`, against the services the CI job
`Portal in a browser` starts (or the equivalent you start locally). The URLs they
need come from `API_GATEWAY_URL`, `WEB_E2E_FLEET_URL` and
`WEB_E2E_MAINTENANCE_URL`.

**These scenarios assume they are the only run using their stack.** CI gives each
job a fresh stack, so the assumption holds there by construction. Locally it is
yours to keep: do not start two live runs against one stack, and do not point a
run at a stack someone else is writing to.

The suite has its own machine (`AST-SEED-E2E-0001`, ORG-DEH-0001) so that it does
not depend on what other scenarios read. That removes interference from _other
specs_; it does not make two _runs_ safe on one stack, and nothing here tries to.
In particular the live maintenance scenarios:

- **do not** tell their requests from another run's, and **do not** guess whether
  an open request belongs to a run that is still going (no title marker, no age
  window);
- **check** the assumption instead: before each test the machine must have no open
  corrective request. If it has one, the test stops with a message naming the
  ids — a previous run left them, or another run is active. Nothing is cancelled
  at that point, because what is open is not this run's to remove;
- **clean up** only what they created: each test records the id of every request
  it files, and `afterEach` cancels exactly those ids (skipping one the test
  already cancelled through the page).

The repair-order scenario takes one request all the way to a **completed** repair
(refer, start, record a part, labour and a charge, complete). That is final for
the order, and a completed request is not open, so it does not trip the check
above on a later run on the same stack: it stays as the record it is. The suite
never approves it — approval authorises settlement, and no browser test may start
money moving. Cleanup still cancels only the ids the run recorded and only while
they are open.

If a run is killed or crashes between filing a request and recording its id, the
next run stops at the check above. Reset the stack (CI never needs this), or
cancel the named requests yourself, and run again.

## Orders (`orders.spec.ts`)

Needs marketplace-service in the stack, started with `MARKETPLACE_TEMPORAL_ENABLED=false`
(ADR-039's no-Temporal mode): no saga runs, so an order stays `PENDING`, no wallet is
touched, and no order reaches economic-service (which is in the stack for the settlements
scenario only). The scenario places orders and reads them; it never confirms receipt and
never settles.

It places orders against the seeded `OFR_SEED_AGGREGATE_D2` (220 available) and **does not
cancel them**: they stay as records on that stack, and each run uses up a little of the
offer's availability. CI starts a fresh stack, so that is nothing there; a local re-run on
the same stack keeps consuming it (and, like the other write scenarios, assumes it is the
only run). The scenarios run in order and share the id the first one places.

## Settlements (`settlements.spec.ts`) — the one scenario that settles

`/settlements` is read-only, so the scenario has to make settlements before it
can read them. It does that **through the gateway, as ORG-DEH-0001's
administrator** (top-up → obligation → authorise → settle), which is a ledger
movement and is why the sentence above ("no browser test may start money moving")
carries this one exception. Nothing real moves: economic-service's only payment
provider is the mock one, and the browser job starts it for this spec alone.

- It has no cleanup, because a settlement is final and append-only: each run adds
  two, found by the ids it just made, so earlier runs on the same stack do not
  disturb it (the one-run-per-stack rule above still holds).
- The "another tenant's settlement" check uses ORG-DEH-0002's administrator as
  the non-party and a settlement ORG-DEH-0001 made to an id (`ORG-E2E-THIRD`) no
  seeded person belongs to, because the development realm has no third tenant
  administrator. The service's rule is the same either way.

## Contract statements (`contract-statements.spec.ts`) — a fixture, and people of its own

contract-service has no route that creates a contract (one is drafted only from
`TENDER_AWARDED`), so this scenario starts from a **fixture**:
`fixtures/contract-statements.sql`, loaded by the "Portal in a browser" job as
contract-service's runtime role through every guard its database keeps — one
SIGNED contract (ORG-DEH-0001 employing `ORG-E2E-CONTRACTOR`) and the two
statement chains in force. The file says what each row is. Everything after that
is done **in the browser**: draft, submit, the technical approval, a
separation-of-duties refusal, the financial approval.

- It needs `WEB_LIVE_STACK_E2E_CONTRACTS=true` (contract-service up, the fixture
  loaded), and under `CI` a skip fails the job.
- The realm holds no contractor and only one person in ORG-DEH-0001 with the
  financial step's role, so it **provisions two people per run** the way the
  platform does (`provisioned-people.ts`: `POST /v1/users` as `system.admin`, then
  a throwaway password through Keycloak's admin API — `KEYCLOAK_ADMIN_PASSWORD`).
  Usernames carry the run's id; nothing is cleaned up, as for settlements.
- Each run adds one approved statement to the fixture's contract, found by the
  id its own draft returned; the contract's price is large enough for many runs.

## A contractor's bid (`tender-bids.spec.ts`) — a fresh tender per test, through the routes

Unlike the contract scenarios, a tender can be made through the platform's own routes, so
nothing here is a fixture: `tender-cast.ts` makes, **once per run** (per hook run, so a retry in
a new worker makes its own), an owner organization under ORG-UNION-YAZD with its
`project.execution` and `tender.publication` policies (written by `union.admin`, put in force by
`system.admin`), two of its administrators (the one who asks never approves), an approved
project, a contractor qualified for CONTRACTING at supplier-service, an invited contractor that
is not, and a contractor of ORG-DEH-0002. **Every test publishes its own tender** on that
project, so a retry bids on a tender nobody has bid on. In the browser: submit, replace and
withdraw a bid (read back with the contractor's own token — receipt and status, never content);
the unqualified contractor refused `BIDDER_NOT_ELIGIBLE` in fixed words; a form drawn before
the deadline and sent after it refused `BID_WINDOW_CLOSED` (the test waits on the clock for
about 45 s); the other tenant's contractor shown the restricted tender as a missing id.

- It needs `WEB_LIVE_STACK_E2E_TENDERS=true`: construction-service started with a
  `CONSTRUCTION_TENDER_KEKS` key (the job mints one per run) and supplier-service up. Under
  `CI` a skip fails the job.
- It reruns locally against the same stack: every run makes new organizations, people and
  tenders, and cleans up nothing, as for settlements.

## Adding a live scenario

- Record the id of everything the scenario creates and clean up by id, not by
  title or prefix.
- If it uses a machine other scenarios also write to, say so in the spec header
  and either serialise it (`test.describe.configure({ mode: 'serial' })`) or give
  it a machine of its own.
- Read back what the service holds with the same token, so the portal is not the
  only witness of its own write.
