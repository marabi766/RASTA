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

If a run is killed or crashes between filing a request and recording its id, the
next run stops at the check above. Reset the stack (CI never needs this), or
cancel the named requests yourself, and run again.

## Adding a live scenario

- Record the id of everything the scenario creates and clean up by id, not by
  title or prefix.
- If it uses a machine other scenarios also write to, say so in the spec header
  and either serialise it (`test.describe.configure({ mode: 'serial' })`) or give
  it a machine of its own.
- Read back what the service holds with the same token, so the portal is not the
  only witness of its own write.
