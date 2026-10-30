# Internal-token HTTP transport: enforcement scope and follow-up

PR #423 protects the 23 current production call sites, **including `internalGet`**,
with `internalFetch`. It sets `redirect: 'manual'` after caller options, refuses
301/302/303/307/308 before parsing, cancels without awaiting cancellation, and
exposes no redirect URL, Location or response body in the error. A 304 remains a
normal response; the gateway relays it and records success, clearing previous
failures. Its breaker is per service and shared across tenants within one gateway
instance. 300 (multiple choices) and deprecated 305 do not trigger Fetch navigation;
they and unknown 3xx retain the caller's previous status semantics.

The transport lint rule runs from workspace directories over `src`, `dev`, and
`prisma` TypeScript, plus root scripts. It detects known raw transport names and
aliases only in modules containing the internal header literal. Unit/integration
specs and test helpers are excluded. The sole E2E transport implementation,
`tests/e2e/src/http.ts`, has an explicit local exemption because it uses a hand
guard instead of a nest-common runtime dependency. Real-HTTP Actor tests verify
that guard, including 304 passthrough; a real-ESLint test verifies the exemption
and rejection in other E2E source files. This is a transport regression rule,
**not a complete credential or token-source boundary**.

## Follow-up 1: type-aware token-source boundary (review F3, deferred)

The PM's Task 830 addendum permits this follow-up. A safe implementation needs
TypeScript symbol/type resolution across workspace configs and one nest-common
internal HTTP client, followed by migration of issuance and sending together at
all 23 call sites. Doing that here would extend a transport repair into a separate
cross-workspace client API migration. No sender migration or blanket `.issue(` or
header ban is introduced here. The present runtime protections remain in place,
but future senders can evade the lint rule as detailed below.

The follow-up must reject use of **InternalTokenService.issue**, resolved through
its type/import rather than method spelling, outside that client. It must cover
aliased imports, computed access, destructuring and aliased issuance methods.
Unrelated domain issuance (RFQ and inventory reservations) must remain valid.
Ban the internal header only in outbound request construction. Explicit, tested
exceptions must cover logging redaction, OpenAPI declarations, test token
factories and the E2E hand guard. Preserve signed tenant SERVICE context, RELAY,
tenant-less platform reads and replacement of caller-provided internal headers.

The following review evasions are **open**, not claimed as fixed or moot. Each
requires a failing rule/real-workspace fixture in Follow-up 1; test results for
the current transport rule must not be described as source-boundary enforcement.

| Review evasion                             | Required follow-up proof                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Headers/constants built in another file | Cross-file token issuance and outbound-header fixture fails.                                                                                      |
| 2. Constructor parameter transport         | Parameter-property sender cannot obtain a token outside the client.                                                                               |
| 3. Class field transport alias             | Field-initializer sender cannot obtain a token outside the client.                                                                                |
| 4. Destructured transport                  | Destructured fetch and destructured issuance both fail outside the client.                                                                        |
| 5. bind/call/Reflect.apply                 | Indirect transport and aliased issuance fail at the source boundary.                                                                              |
| 6. require/dynamic import                  | Dynamic/require transport fixtures fail without depending on transport imports.                                                                   |
| 7. http2/got/ky/superagent/XHR             | Each alternate transport fixture fails at issuance/header construction.                                                                           |
| 8. Fake local internalFetch                | Local name grants no exception; only the resolved shared client is trusted.                                                                       |
| 9. dev/seed/E2E                            | Workspace ESLint now rejects direct raw sender fixtures in these paths. Source-boundary and E2E exemption tests remain required in the follow-up. |

## One deadline over the whole exchange (#502 r1 F1; PR #507 r1 F1/F2)

`fetch` settles when the response headers arrive, so a client that clears its abort
timer there has no deadline on the body (r1: a server answering `200` and then
stalling or trickling held the caller as long as the socket lived), and a client
that returns on a refusal status without reading or cancelling the body leaves the
connection and its buffers to the same peer, once per retry (#507 r1). One obligation
covers both: **a response's deadline may be released only once its body is
consumed or given up.**

`exchangeWithDeadline` (and `upstreamExchange`, which adds the platform's
`UPSTREAM_TIMEOUT` / `UPSTREAM_UNAVAILABLE` mapping) in `@rasta/nest-common` owns
that obligation, so no caller has to remember it: the signal stays armed through
sending and the reader, the deadline is enforced by the boundary itself (a
transport that ignores the abort still ends at it), a body the reader never
touched — a status-based refusal — is cancelled at once and not awaited, a
response that arrives after the exchange ended is cancelled on arrival, and the
signal is aborted on every exit. The caller leaving can be passed as `cancel`
(the gateway's `abandoned` verdict); the two causes stay apart as
`ExchangeDeadlineError` and `ExchangeCancelledError`. Every internal HTTP client
in `services/*` and `packages/nest-common` goes through it.

The lint rule `internal/exchange-deadline` (`scripts/exchange-deadline-rule.mjs`,
same workspace paths as the transport rule) enforces the boundary instead of
following a caller's control flow: a `setTimeout` whose callback aborts something
(inline, through a local name, a destructured `abort`, `controller.abort` or its
`.bind`) is an error everywhere except `exchange-deadline.ts` itself. The earlier
rule matched `clearTimeout` and body reads by source order, so it missed
`try { return response.text(); } finally { clearTimeout(t); }` and computed or
aliased readers, and it flagged an unrelated `clearTimeout`. `AbortSignal.timeout(…)`
has no timer to clear and stays allowed; a callback imported from another module,
and a deadline built without an abort (a `Promise.race` against a timer), cannot be
seen from one file and are not covered.

## Evidence limits

Real PostgreSQL redirect/recovery tests cover economic settlement-authority,
economic reward-trigger, economic statement-settlement, and contract
settlement-completed. The marketplace committed-response tests are real HTTP
**unit tests with an in-memory commit map**, for all seven economic write
operations including dispute resolution; they are not real-PG commit proofs.
Pagination and failed-bootstrap cursor regressions remain in their existing tests.

The original disabled-rule mutant exercised only direct `Linter` unit tests.
Task 830 adds a real CLI ESLint test in service/package/dev/seed/E2E workspaces,
wired into root `lint:scripts`, and disables the real configured rule to verify
that test detects missing enforcement. No claim of complete alias/data-flow
coverage follows from either mutant.

Other credential-bearing redirect paths are tracked separately in Q-155 in
`docs/24-open-questions.md`.
