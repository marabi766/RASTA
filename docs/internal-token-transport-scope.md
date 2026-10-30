# Internal-token HTTP transport and source boundary

## Transport (PR #423)

Every internal-token request goes through `internalFetch` (`@rasta/nest-common`).
It sets `redirect: 'manual'` after caller options, refuses 301/302/303/307/308
before parsing, cancels without awaiting cancellation, and exposes no redirect
URL, Location or response body in the error. A 304 remains a normal response;
the gateway relays it and records success, clearing previous failures. Its
breaker is per service and shared across tenants within one gateway instance.
300 (multiple choices) and deprecated 305 do not trigger Fetch navigation; they
and unknown 3xx retain the caller's previous status semantics.

The transport lint rule (`internal/transport`) runs from workspace directories
over `src`, `dev`, and `prisma` TypeScript, plus root scripts. It detects known
raw transport names and aliases only in modules containing the internal header
literal; specs and test helpers are excluded, and the E2E transport
`tests/e2e/src/http.ts` is exempt from it (hand guard, below). It is a transport
regression rule. The source boundary below is what keeps tokens away from any
other transport.

## Source boundary (PR #423 follow-up 1)

**One client mints and sends.** `InternalHttpClient`
(`packages/nest-common/src/http/internal-http-client.ts`) is the only code that
calls `InternalTokenService.issue` and the only code that puts `X-Internal-Token`
on an outbound request. `authorize(grant)` mints at the point each caller minted
before, with the same arguments; the sender it returns sends through
`internalFetch`, never exposes the token, and replaces a caller-provided internal
header in any letter case and header representation. All 24 senders use it:
`internalGet` and 23 service clients, including the gateway's RELAY, tenant
SERVICE reads and writes, and tenant-less platform reads. Notification keeps one
token per resolution by keeping one sender across roles and pages.

**The rule** `internal/token-source` (`scripts/internal-token-source-rule.mjs`)
enforces this through TypeScript symbols and types, not spelling:

- **issuance**: any read of the `issue` method, by `.issue`, `['issue']`, a
  constant or `keyof` key, destructuring, `super`, `bind`/`call`/`apply`. It is
  resolved to the method's declaration in nest-common, so a `Pick<…>`, alias or
  re-export is the same method, and a domain `issue()` (RFQ, inventory
  reservations) is not.
- **escape**: an issuance-capable value flowing where its type is lost, such as
  `any`, `unknown`, `object`, a generic parameter, a structural stand-in,
  `Reflect`/`Object.*` or a type assertion. The one allowance is a
  newly-constructed `InternalTokenService` returned to dependency injection,
  which types it again where it is injected.
- **header**: the header name, as a literal, template or constant of that
  literal type in any letter case, used as an object key, an assigned key, a
  `[name, value]` pair or a name followed by a value in a call. Reading it
  (`headers.get`, `req.headers[…]`), logging redaction paths and OpenAPI
  declarations (`name: 'X-Internal-Token'`) are not construction and pass.
- **signer**: jose's signing classes outside `InternalTokenService`, and
  `INTERNAL_TOKEN_SECRET` read anywhere but as the first argument of
  `new InternalTokenService`.
- **fail closed**: without type information the rule reports everything it
  could only clear with types. This covers JavaScript, a file no project
  includes, and text that differs from the file on disk (stdin, an editor
  buffer). It reports `issue` on an untyped value, any import of nest-common or
  of TypeScript source, and any `require`/`import()` whose specifier is not a
  constant. `eval` and `new Function` are refused everywhere.

Types come from the linted file's own workspace project
(`scripts/internal-token-parser.mjs`): `tsconfig.test.json` where one exists
(src, test, dev, seed), otherwise `tsconfig.json`. A file the project does not
include is parsed without types rather than failing. Lint depends on `^build`,
so nest-common's declarations are present.

**Scope (R2-1).** The rule is on for every extension ESLint lints
(`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) in every workspace with a `lint`
script, in `apps/web` (its own config restates the rule with its own parser),
in the E2E workspace's root files, and in root `scripts/`. Test token factories
are the one exemption: `*.spec.*`, `*.int-spec.ts`, `*.e2e-spec.ts`, `*.test.*`
and `test/` trees. The E2E harness has two exceptions, each scoped to one
function: `send()` in `tests/e2e/src/http.ts` sets the header behind its
redirect hand guard (`actor.ts` now passes the token to it), and
`mintInternalToken()` in `tests/e2e/src/internal.ts` signs the wire format.

### Evasions from review F3, each with its failing fixture

All fixtures are in `scripts/internal-token-source-workspace.test.mjs`. Each is
a real file linted by the real ESLint binary from the workspace directory, with
that workspace's config and project. Each must fail on the intended message,
never a parser error. The test runs in root `lint:scripts`, so it runs in CI.

| Review evasion                             | Closed by                                                                                                                                                                      | Fixture (test → file)                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Headers/constants built in another file | issuance and header resolved through imported types, including a header constant                                                                                               | "economic-service: the nine evasions…" → `e1-header-module.ts`, `e1-sender.ts`                                                                        |
| 2. Constructor parameter transport         | issuance on the parameter property; header                                                                                                                                     | `e2-constructor.ts`                                                                                                                                   |
| 3. Class field transport alias             | issuance in the field initializer; header                                                                                                                                      | `e3-field.ts`                                                                                                                                         |
| 4. Destructured transport                  | destructured `issue`; `[name, value]` header pair                                                                                                                              | `e4-destructured.ts`                                                                                                                                  |
| 5. bind/call/Reflect.apply                 | issuance on each; `Reflect.get` is an escape                                                                                                                                   | `e5-indirect.ts`                                                                                                                                      |
| 6. require/dynamic import                  | `require` of nest-common and `import(expr)` unresolved; header                                                                                                                 | `e6-dynamic.ts`; JS: "root scripts: plain JavaScript fails closed"                                                                                    |
| 7. http2/got/ky/superagent/XHR             | issuance, and the header refused five times, once per transport                                                                                                                | `e7-alternates.ts`                                                                                                                                    |
| 8. Fake local internalFetch                | only the client's file is exempt; a local `internalFetch` or `InternalHttpClient` grants nothing                                                                               | `e8-fake-client.ts`; "nest-common: only InternalHttpClient may mint…"                                                                                 |
| 9. dev/seed/E2E                            | `dev/`, the seed, a `prisma/` file outside every project, E2E `src` and root files, `global-setup.ts`, `playwright.config.ts`; the two E2E exceptions refuse a second function | `dev/…`, `prisma/…`, "…the real seed is linted…", "tests/e2e: src, root files and the two named exceptions", "the rule sees types for the seed, E2E…" |

The fail-closed cases have fixtures too: `f-structural.ts` (structural `Pick`,
stand-in type, erased type, `keyof` and dynamic keys, `any`), `f-reexport*.ts`,
`f-signer.ts`, `prisma/…` (outside the projects), one file per extension
(economic and `apps/web`), and root scripts. The exceptions are fixtures that
must pass: `v-domain.ts` (RFQ/reservation `issue()`, header reads, redaction,
OpenAPI, issuer construction for DI), `t-factory.spec.ts`, `test/…/factory.ts`,
web `factory.spec.ts`, the real `http.ts` and `internal.ts`. The structural test
holds every workspace's `lint` script to the rule (level and parser) at every
extension and every path the script names, and expects `off` only under `test/`.

**Files ESLint does not lint at all** are the workspace config files
(`eslint.config.mjs`, `jest.config.*`, `jest.setup.cjs`, `jest.swc.cjs`,
`jest.disclosure-guard.cjs`, `next.config.mjs`, `postcss.config.mjs`,
`upload-limit.cjs`, web `playwright.config.ts`, `next-env.d.ts`) and
`apps/web/e2e/**` (Playwright browser specs; `eslint src` does not reach them).
A text guard in the same test scans every tracked JS/TS file that no lint script
covers. It fails on the header, `InternalTokenService`, `InternalHttpClient`,
`issue` access, jose signers, the secret or nest-common. That guard is
spelling-based; none of these files sends anything today.

## Limits

- **Injected fetch.** The client hands each request, header included, to the
  fetch it was given: the global one, or a test's. Production modules construct
  clients without one; the rule does not prove what an injected function does.
- **Dependency injection by a string or symbol token.** A parameter injected
  with a structural type naming `issue` is caught where `issue` is read. One
  typed as a string-indexed record and read with a computed key is out of
  static reach.
- **Untyped scripts.** A specifier built from constants is followed through
  `const` bindings and call arguments (`join`, `resolve`, `pathToFileURL`), not
  into a helper function's body.
- **Each workspace's own `lint` script** is proven by the opt-in case of the
  same test (`INTERNAL_TOKEN_LINT_SCRIPTS=1`; a full repository lint, not run in
  CI). CI runs the structural test, which checks the configuration those
  scripts load.

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

Other credential-bearing redirect paths are tracked separately in Q-155 in
`docs/24-open-questions.md`.
