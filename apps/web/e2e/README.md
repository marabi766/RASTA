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

## Contract commands (`contract-commands.spec.ts`) — a fresh contract per test

For the same reason (no route creates a contract), **each test writes its own**
(`contract-fixture.ts` running `fixtures/contract-draft.sql` as contract-service's
runtime role, through every guard its database keeps): a draft nobody has signed,
or one both sides have signed under `contract-statements.sql`'s signing policy,
with ids chosen for that attempt — so a retry runs against new state, never what
an earlier attempt signed or cancelled. Everything else is done in the browser:
both sides accept a draft; a cancel form the employer opened before the contractor
signed is refused once it has (`SIGNATURE_RECORDED`, in the page's fixed words);
the employer proposes an amendment and both sides sign it; the employer plans a
milestone and changes it; ORG-DEH-0002, with no signing policy in force, is told
nobody may sign for it, and sees ORG-DEH-0001's contract as a missing id.

- Same flag (`WEB_LIVE_STACK_E2E_CONTRACTS=true`) and CI rule; it also needs
  `WEB_E2E_CONTRACT_DATABASE_URL` (the runtime role's URL, set by the job) and
  `psql` on the path, and provisions its own contractor per run.
- It reruns locally against the same database: every run writes new contracts.

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

## The owner's side (`tender-owner.spec.ts`) — publish, open, a fresh tender per test

The same cast as the bid scenarios (`tender-cast.ts`, once per run), and **every test drafts its
own tender** (`draftTender`). In the browser: the author asks for publication, is told it waits
and is offered no grant (only the rejection, being the step's authority too); the approver grants; the author executes it on the same version. A
draft without criteria is refused with every reason in fixed words and no approval round opens.
A tender published with a one-minute window gets a contractor's bid through the gateway; once
construction-service closes it at the deadline (the test polls its status), the author proposes
the opening, is refused opening it alone (`SECOND_PERSON_REQUIRED`), and the approver opens it — an
opening whose answer is lost (audit-service still catching up) is never re-sent, so the test sets
it aside and opens again from a fresh form — after which the bid's price is shown.
ORG-DEH-0002's administrator sees the owner's tender as a missing id, in
the page and on every owner route through the gateway.

- It needs `WEB_LIVE_STACK_E2E_TENDERS=true` and, besides what the bid scenarios need,
  audit-service up (the opening is checked against its receipts). Under `CI` a skip fails the job.
- It reruns locally against the same stack, as the bid scenarios do.

## The evaluation and the award (`tender-evaluation.spec.ts`) — each test its own tender

The cast is made with `{ evaluation: true }`: besides the bid scenarios' people, the owner's
`tender.award` policy naming the administrator of a **reviewer organization** made for the run,
that reviewer, an evaluator (a third owner administrator, who takes no other part) and a rival (a
second qualified contractor, invited too). **Every test makes the tender it needs** with the
cast's helpers, so no test depends on another having run (AGENTS.md § 5; PR 346 review 2,
finding 4) and the describe runs in parallel: `openedTender` (published with a one-minute
window, bid on by both contractors through the gateway, closed by construction-service at its
deadline, proposed by the author and opened by the approver, again while audit-service catches
up), and from it, through the gateway, `evaluatedTender` (qualified, disqualified, scored and
completed by the evaluator), `awardRequestedTender` (the author asks), `awardApprovedTender` (the
reviewer grants) and `awardedTender` (the author executes, again on a `503`/`504`). A test takes
fresh tokens for the cast's people (`freshCast`). Each test has at most one accessibility scan.
In the browser: ORG-DEH-0002's administrator, and the contractor itself, get the 404 of a
missing id on every evaluation and award route, and the page shows the same absence; the
evaluator qualifies the contractor, disqualifies the rival with a closed reason, scores in
Persian digits (`۸٫۵`, and a pass), sees the weighted total, completes the evaluation, and is
told the award is someone else's (`AWARDER_NOT_EVALUATOR`); the author asks for the award and is
offered neither the grant nor the rejection (the step names the reviewer's organization); the
reviewer — whose read of the tender is a 404 — finds the step through the approval inbox, sees
the bid it names and grants it; the author executes it (an execution whose answer is lost is set
aside and executed anew from a fresh form, never re-sent), the award shows the winner's price,
and the strangers still find nothing. Each contractor's own page shows its own bid's status and
nothing of the other's or of the scores.

- It needs what the owner's scenarios need. Under `CI` a skip fails the job.
- It reruns locally against the same stack, as the bid scenarios do.

## Adding a live scenario

- Record the id of everything the scenario creates and clean up by id, not by
  title or prefix.
- If it uses a machine other scenarios also write to, say so in the spec header
  and either serialise it (`test.describe.configure({ mode: 'serial' })`) or give
  it a machine of its own.
- Read back what the service holds with the same token, so the portal is not the
  only witness of its own write.
