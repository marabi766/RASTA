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

## Source boundary (PR #423 follow-up 1; #503 r2)

**One client mints and sends.** `InternalHttpClient`
(`packages/nest-common/src/http/internal-http-client.ts`) is the only code that
mints an internal token and the only code that puts `X-Internal-Token` on an
outbound request. `authorize(grant)` mints at the point each caller minted
before, with the same arguments; the sender it returns sends through
`internalFetch`, never exposes the token, and replaces a caller-provided internal
header in any letter case and header representation. All 24 senders use it:
`internalGet` and 23 service clients, including the gateway's RELAY, tenant
SERVICE reads and writes, and tenant-less platform reads. Notification keeps one
token per resolution by keeping one sender across roles and pages.

### The boundary holds at run time

Review r1 showed that a lint rule alone cannot hold this (`Reflect.get` with a
computed name is undecidable), so the guarantee is enforced where it runs:

- **The issuer lives with the client.** `InternalTokenService` is declared in
  the same module as `InternalHttpClient`. Its HMAC key, issuer and TTL are in a
  `WeakMap` private to that module, frozen. The instance has no own properties,
  no symbols and no getters, so `Reflect.get(t, 'key')` finds nothing. Before
  r2 the key was a TypeScript `private` field, which is an ordinary property at
  run time (141 probe, escape 2).
- **`issue()` throws a `TypeError`**, however it is reached: a cast, a
  container, a closure, a generic `Reflect.get` wrapper with a joined name,
  `call`/`apply`/`bind`, a computed name, or `new InternalTokenService(…) as any`.
  `authorize` mints for a genuine instance through a module-private `mint()`.
  An object that is no genuine instance is asked through its own `issue()`;
  this is what lets sender unit tests stand in with `{ issue }`. Such a
  stand-in signs nothing a service accepts, and an object built on the
  prototype reaches the throwing `issue()`. A subclass that overrides
  `issue()` is ignored, and it gains no key.
- **The client is frozen** when constructed, so the transport and issuer of a
  client production code already holds cannot be swapped.
- **No subpath.** `@rasta/nest-common`'s `package.json` has
  `"exports": { ".": … }`. Node refuses every `@rasta/nest-common/dist/…`,
  `/src/…` and `/package.json` specifier, for `require` and `import`, with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Before the change no workspace imported a
  subpath (`git grep "@rasta/nest-common/"`: only an ADR's prose and a
  fixture string). Scripts that load `dist` by file path are unaffected.

`packages/nest-common/src/http/internal-token-boundary.spec.ts` runs every F1/F2
snippet of the review, and the 141 probe's escapes, against the real classes:
none yields a token `verify` accepts. The subpath case resolves from a real
consumer (economic-service) in a child Node process.

### The secret stays in the environment (D-086)

`INTERNAL_TOKEN_SECRET` stays a string in the environment and in each service's
`ENV` object, which hands it to `new InternalTokenService(…)`. **The process is
the trust boundary.** Code running inside a service process can read
`process.env` and can rewrite anything that process shares: jose, `crypto`,
`WeakMap.prototype`, `globalThis.fetch`. No in-process seal survives that. An
opaque secret handle with a scrubbed environment (task 141, D1(a)) would add a
second process-local hiding place while code in the same process still runs.
It would also touch config, 17 app modules and every test that loads the
environment twice. The run-time boundary therefore guarantees something
narrower: **no object reachable from nest-common's API hands out a token or the
key.** The rule refuses naming the secret anywhere but as the issuer's first
argument. That covers a property, a string, a folded or joined name, and a
computed key on a value that holds it. Per-workload identity (mTLS, ADR-020,
risk S-03) remains the replacement for the shared secret.

### The lint rule is the second layer

`internal/token-source` (`scripts/internal-token-source-rule.mjs`) refuses at
review time what the run time would refuse, or what it cannot see. It decides
through TypeScript symbols and types, not spelling:

- **issuance**: any read of the `issue` method, by `.issue`, `['issue']`, a
  constant, folded (`'is' + 'sue'`) or `keyof` key, destructuring, `super`,
  `bind`/`call`/`apply`. It is resolved to the method's declaration in
  nest-common, so a `Pick<…>`, alias or re-export is the same method, and a
  domain `issue()` (RFQ, inventory reservations) is not.
- **escape**: a value that carries the issuer flowing where that is lost. It
  may carry it directly, or inside a public property, an element, a type
  argument (a promise) or a function's return, three levels deep. It is lost
  in `any`, `unknown`, `object`, a structural stand-in, a type assertion,
  `Reflect`/`Object.*`, or a generic parameter (`<T>(t: T)`). For a generic
  parameter the call site is refused, because inside the generic nothing
  carries a type. The one allowance is a verified DI factory:
  `new InternalTokenService(…)` returned from the `useFactory` of a provider
  whose `provide` is `InternalTokenService`, and that provider object.
- **header**: the header name as a literal, template, constant of that literal
  type, or folded through `+`, `[…].join`, `concat` or letter case, in any
  case. It is refused as an object key, an assigned key, a `[name, value]`
  pair or a name followed by a value in a call. Reading it (`headers.get`,
  `req.headers[…]`), logging redaction paths and OpenAPI declarations are not
  construction and pass.
- **signer**: jose's signing classes from `jose` or any `jose/…` subpath, the
  four signing subpaths included. Also refused: a jose namespace used other
  than as `ns.<fixed non-signing name>` (an alias, a computed member, an
  argument), and `INTERNAL_TOKEN_SECRET` named anywhere but as the first
  argument of `new InternalTokenService`.
- **fail closed**: without type information (JavaScript, a file no project
  includes, text that differs from the file on disk), `issue` and a computed
  key on the issuer or on a value holding the secret are refused. In
  production code (every path that is neither test-only by `isTestOnlyPath`,
  `scripts/test-only-path.mjs`, nor root tooling in `scripts/`) the rule also
  refuses:
  - nest-common or TypeScript source imported without types;
  - any module loader (`require`, `module.require`, `createRequire(…)`, any
    `const` alias of them, `import()`) whose specifier is not a constant. A
    specifier is followed through `const`, `+`, templates and the path
    builders (`join`, `resolve`, `dirname`, `pathToFileURL`, `new URL`), and
    tested whole, so `'@rasta/' + 'nest-' + 'common'` is nest-common. Any
    other call's result is unknown;
  - a loader or code generator used other than by calling it;
  - code generation: `eval`, `Function`, `globalThis.eval`, a `vm` import, a
    `.constructor(…)` call, a string timer;
  - without types, a method called by a computed name or through `Reflect`.

  Test-only code (`tests/`, test trees, `packages/testing`, test-runner files)
  is never in an image, and no production file may import it (the source sweep
  in `scripts/testing-dev-only-source.mjs`, PR #514). Root tooling (`scripts/`)
  is CI and operator code, not copied into an image: a production file that
  imports one makes it production for that sweep, which follows it and refuses
  its loaders. Today the root tooling it follows is the lint configs and their
  rule modules. In both, the run-time boundary alone answers loaders.
  `isTestOnlyPath` has one definition, in a module with no loader
  (`scripts/test-only-path.mjs`), because the lint configs the sweep follows
  import it through this rule.

Types come from the linted file's own workspace project
(`scripts/internal-token-parser.mjs`): `tsconfig.test.json` where one exists
(src, test, dev, seed), otherwise `tsconfig.json`. A file the project does not
include is parsed without types rather than failing. Lint depends on `^build`,
so nest-common's declarations are present.

**Scope.** The rule is on for every extension ESLint lints
(`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) in every workspace with a `lint`
script, in `apps/web` (its own config restates the rule with its own parser),
in the E2E workspace's root files, and in root `scripts/`.

### Every exemption, with its reason

| Config                            | Exemption                                                                                                  | Reason                                                                                       | Why production cannot reach it                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| root `INTERNAL_TOKEN_SOURCE`, web | rule `off` for `*.spec.*`, `*.int-spec.ts`, `*.e2e-spec.ts`, `*.test.*`, `test/**`                         | test token factories exercise the services' guards                                           | test-only by `isTestOnlyPath`; the source sweep refuses any production import of a test-only file, by its resolved target (extensionless imports included) |
| root, allow `header`              | `send()` in `tests/e2e/src/http.ts`                                                                        | the E2E transport (no nest-common dependency) sets the header behind its redirect hand guard | `tests/` is test-only                                                                                                                                      |
| root, allow `signer`              | `mintInternalToken()` in `tests/e2e/src/internal.ts`                                                       | the E2E harness signs the wire format itself                                                 | `tests/` is test-only                                                                                                                                      |
| root, allow `signer`              | `e2eConfig()` in `tests/e2e/src/env.ts`                                                                    | the harness reads the secret by name from its environment                                    | `tests/` is test-only                                                                                                                                      |
| root, allow `signer`              | `mintTestInternalToken()` in `packages/testing/src/internal-token.ts`                                      | the services' test factories mint here (PR #514)                                             | devDependency only; checked in source, in the production dependency graph and in images (`scripts/testing-dev-only.mjs`)                                   |
| root, allow `signer`              | `secretName()` in `scripts/internal-token-source-rule.mjs`                                                 | the rule names the secret it refuses                                                         | root tooling; it returns a name, not a capability                                                                                                          |
| root, allow `header`              | `credentialNames()` in `scripts/internal-token-transport-rule.mjs`                                         | the transport rule lists the header among the credentials it checks (Q-155)                  | root tooling; it returns a name, not a capability                                                                                                          |
| root, web, e2e                    | global ignores (`node_modules`, `dist`, `.next`, `.turbo`, `coverage`, `src/generated`, Playwright output) | build output and generated code                                                              | linted by the coverage test below when tracked                                                                                                             |
| nest-common                       | the client file itself (`internal-http-client.ts`)                                                         | holds the issuer, `mint()` and the header                                                    | it is the boundary                                                                                                                                         |

The coverage tests in `scripts/internal-token-source-workspace.test.mjs` derive
this from ESLint itself, not from directory prefixes. For every tracked JS/TS
file they ask each lint script's ESLint whether it lints the file, and at which
level:

- every file linted with the rule off must be test-only;
- every allowance must name a test-only file or a root lint rule;
- every file no lint script reaches is linted there with the rule itself,
  without types and with inline configuration off. These are root config
  files and ignored paths (`apps/web/e2e/**` is linted by the portal since
  PR #492). This replaces r1's spelling scan, which
  the review's generic `mint<T>` helper passed;
- no production file may hold an inline directive that switches an `internal/`
  rule off, or a blanket `eslint-disable`.

### Review evasions and their fixtures

Every fixture is a real file linted by the real ESLint binary from its
workspace. Expectations are per line: a marked line must carry its report and
an unmarked line must carry none. r1's helper only checked that a message
occurred somewhere in a file (review "Fixtures"), so one case could hide
another.

| Review                                                                                                                                                                             | Closed at run time by                          | Lint fixture                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| r1 F3 evasions 1–9 (headers in another file, constructor/field/destructured transports, bind/call/Reflect, require/import, http2/got/ky/superagent/XHR, fake client, dev/seed/E2E) | `issue()` throws; the key is no property       | `e1`–`e8`, `f-*`, `dev/…`, `prisma/…`, seed, E2E cases                                          |
| r2 F1: containers and arrays cast through `unknown`, closure-return cast, spread widening, generic `Reflect.get` wrapper, `new …() as any`                                         | `issue()` throws                               | `r2-f1.ts` (each on its own line), DI factory allowed only with `provide: InternalTokenService` |
| r2 F2: jose subpaths, namespace alias, computed `j['Sign'+'JWT']`                                                                                                                  | no key reachable: nothing to sign with         | nest-common `subpaths.ts`, `namespace.ts`, `reexport.ts`                                        |
| r2 F2: secret by `Reflect.get`, joined, folded, cased or computed name                                                                                                             | D-086: process boundary                        | `r2-f2-secret.ts`; E2E `env.ts` widened                                                         |
| r2 F2: header by `join`, `toLowerCase`, entries                                                                                                                                    | the client replaces the header (run-time spec) | `r2-f2-header.ts`                                                                               |
| r2 F3: untyped computed `issue`, split module names, `require`/`eval`/`Function` aliases, `module.require`, `createRequire`, `globalThis.eval`, helper-built specifiers            | `issue()` throws                               | `r2-f3.mjs` (production JavaScript); root scripts keep issuance, header and secret              |
| r2 F4: exempt helper imported by production; unlinted generic wrapper; ignored paths                                                                                               | `issue()` throws                               | "review F4…" (refused by the source sweep), both coverage tests                                 |

## Limits

- **The transport sees the header (141 probe, escape 3).** A client hands each
  request, header included, to the transport it was built with. That is the
  global `fetch` in production wiring. About 12 production clients forward an
  optional `fetchImpl` test seam to the client; production modules pass none.
  Code that builds a client with its own transport, or replaces
  `globalThis.fetch`, receives a valid token. Sealing that would mean removing
  the seam from those clients and their specs. The token stays bounded: one
  audience, one organization (signed), one TTL. The run-time spec pins this
  residual so the doc stays true.
- **Code that rewrites the shared runtime** (jose, `crypto`, `WeakMap`,
  intrinsics) or reads the environment is inside the trust boundary (D-086).
- **A secret name computed from run-time input** (`process.env[name]`, where
  `name` is no constant) is out of static reach. `process.env` declares no
  such property, so only a constant name is refused there.
- **Dependency injection by a string or symbol token.** A parameter injected
  with a structural type naming `issue` is caught where `issue` is read. One
  typed as a string-indexed record and read with a computed key is caught only
  at run time.
- **Each workspace's own `lint` script** is proven by the opt-in case of the
  same test (`INTERNAL_TOKEN_LINT_SCRIPTS=1`; a full repository lint, not run in
  CI). CI runs the structural and coverage tests, which check the
  configuration those scripts load.

**Status after task 135 (PR #492 round 2):** the _transport_ half of every row is closed by
the boundary below. Outside the audited files no raw sender can be reached at all, so it does
not matter where the headers were built (row 1) or how the transport was aliased (rows 2–8);
dev, seed and both E2E trees are covered (row 9). Each row has a failing fixture in
`scripts/raw-http-boundary-rule.test.mjs`, under the real workspace configs too. The
_token-source_ half (who may call `InternalTokenService.issue`, and where the internal header
may be built) is a separate question from redirects and **stays open** as written above.

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

The two boundaries compose (merge of #502/#507 into PR #492): `internalGet` sends on the
`InternalHttpClient` sender, which is `internalFetch` with redirects refused, inside
`upstreamExchange`. `exchange-deadline.ts` holds the timer, not a sender. It is not in
`AUDITED_TRANSPORTS`, and `internal/raw-http` runs on it as on any other file.

## Evidence limits

Real PostgreSQL redirect/recovery tests cover economic settlement-authority,
economic reward-trigger, economic statement-settlement, and contract
settlement-completed. The marketplace committed-response tests are real HTTP
**unit tests with an in-memory commit map**, for all seven economic write
operations including dispute resolution; they are not real-PG commit proofs.
Pagination and failed-bootstrap cursor regressions remain in their existing tests.

## Q-155: every credential, not only the internal token (task 106)

The same policy now covers every credential-bearing call outside the services'
`internalFetch`: the portal's `credentialFetch` (`apps/web/src/server/credential-fetch.ts`,
for the gateway bearer and the OIDC token grants), `scripts/credential-fetch.mjs` (the
Grafana probe's Basic auth, run unbuilt in a bare Node container), and the E2E hand guard,
which now refuses redirects for every request. The portal and scripts cannot import
nest-common, so each keeps a copy; `scripts/credential-fetch.test.mjs` pins all four to the
same five statuses and the same `redirect: 'manual'` placement, and tests the scripts copy
over real HTTP. `apps/web/src/server/credential-redirects.spec.ts` does the same for the
portal's callers.

The lint rule now triggers on a module that sends any credential, detected
**syntactically in the same module**: a property key or string literal naming
`authorization`, `proxy-authorization`, `cookie`, `x-api-key`/`api-key`/`apiKey` or
`x-internal-token`; a `Bearer `/`Basic ` value; or the form fields `client_secret`,
`client_assertion`, `refresh_token`, `code_verifier`, `access_token`, `subject_token` and
`password`. In such a module every raw `fetch`/`fetchImpl`/`request`/`axios` call (and alias),
and every `http`/`https`/`undici`/`axios`/`node-fetch` import, fails. The portal's own
`eslint.config.mjs` now runs the rule on `src` (specs and `src/test` excluded). The real
workspace tests cover services, packages, `dev`, E2E, the portal (`.ts` and `.tsx`) and
root scripts, both directions, for every credential kind. `__tests__` fixtures are excluded
with the other test helpers.

This is **syntactic coverage, not a credential-source boundary**. A header name or form
field built in another file, a computed name from a variable, or the other evasions in the
table above still pass. They stay open in Follow-up 1, which must cover credential headers
as well as internal-token issuance.

Temporary exemption (task 106, now gone): `keycloak.client.ts` was exempt until #483 moved
its three exchanges to `internalFetch`. #483 merged (`main` 5908da19), the branch merged
that `main`, and the block was deleted. Both transport rules run on the file, and
`internal-token-transport-workspace.test.mjs` fails if an exemption returns.

Sweep (task 106) and exclusions: Q-155 in `docs/24-open-questions.md`. Superseded in round 2
(next section): the `apps/web/e2e` helpers and specs are no longer excluded. The browser's
same-origin `/auth/session` probe sends only the browser's own cookie
(`credentials: 'same-origin'`, never a cross-origin target). The portal's browser-E2E
helpers and specs under `apps/web/e2e/` are test-only and outside the portal's linted
`src`. Both are excluded.

## Q-155 round 2: the transport boundary (task 135, PR #492 r1 F1/F2)

The credential rule above recognises a credential by its spelling, so a header assigned
as `headers.authorization = token`, a destructured, bound or class-field `fetch`,
`Reflect.apply`, a dynamic import or a computed name all passed it (r1 F1). The fix
enforces the boundary instead: `internal/raw-http` (`scripts/raw-http-boundary-rule.mjs`)
refuses **any reference to a raw HTTP primitive** outside `AUDITED_TRANSPORTS`, whatever
the module sends:

- the global `fetch`, `XMLHttpRequest`, `eval` and `Function`, referenced in any value
  position (called, bound, `call`/`apply`, `Reflect.apply`, returned, assigned, a class
  field, a default parameter, `?? fetch`). Scope analysis decides what is global, so a
  local binding or an injected `deps.fetch` is not a reference; type positions
  (`typeof fetch`) are not either;
- the global object (`globalThis`, `window`, `self`, `global`, …) used as a value (alias,
  spread, destructuring, an argument such as `Reflect.get(globalThis, …)`), with a
  computed member (`globalThis[name]`), or with a raw member (`.fetch`). `typeof window`,
  `'x' in globalThis`, a plain safe member (`globalThis.crypto`) and a symbol key stay legal;
- HTTP client modules (`undici`, `axios`, `node-fetch`, `got`, `superagent`, `ky`, …,
  `playwright`, `playwright-core`) imported, re-exported, `import x = require`d, loaded
  with `require`, `import()`, `module.require`, `process.getBuiltinModule` or an aliased
  loader. A computed loader argument is refused unless it is provably a file
  (`join(ROOT, …)`, `resolve(dir, …)`, `pathToFileURL(…).href`, directly or through a
  `const`). From `node:http(s)`/`http2`, the client half (`request`, `get`, `connect`,
  `Agent`, `globalAgent`, `ClientRequest`, the default or namespace import) is refused,
  and the server half (`createServer`) is not; type-only imports are not references;
- in the two E2E trees (option `playwright`), Playwright's unguarded API contexts:
  `playwright.request`, `page.request`, `context.request`, a destructured `request`, and
  value imports of anything but `expect`, `defineConfig` and `devices` from
  `@playwright/test` (an unguarded `test` brings an unguarded `request` fixture).

It runs, at `error`, on non-test source of `apps/web/src`, `services/*/{src,dev,prisma}`,
`packages/*/src` and `scripts/`, and on **everything** in `apps/web/e2e` and `tests/e2e`
(specs included; only the node:test unit tests of the harness, `tests/e2e/src/*.test.ts`,
are not scenarios and are excluded), and on every `*.live-spec.ts` wherever it lives
(PR #492 r2 F2: a live suite aims at an endpoint the environment names, with real
credentials). The portal's lint now includes `e2e`. A real-config
test computes the rule for every in-scope tracked file (more than a thousand) in its own
workspace and checks that the workspace's lint script reaches it. Another test holds inline
disables of either rule to one pinned line. The credential rule stays on as a second layer.

`AUDITED_TRANSPORTS`: exact files, never directories. A test checks that each entry exists,
has a reason, and that the list equals a pinned copy. An exempt file is exempt only as that
file. **What each one exports is reviewed by hand**; the boundary cannot follow a raw sender
handed out of an audited file:

| Audited file                                        | What it exports                                                        | Reviewed                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/nest-common/src/http/internal-fetch.ts`   | `internalFetch` (refuses the five statuses)                            | no raw sender exported                                                                  |
| `apps/web/src/server/credential-fetch.ts`           | `credentialFetch`, its error                                           | no raw sender exported                                                                  |
| `apps/web/src/server/signed-url-upload.ts`          | `putToSignedUrl` (`redirect: 'error'`, set after the caller's init)    | no raw sender exported                                                                  |
| `apps/web/src/lib/session-refusal.ts`               | `sessionHasEnded` (a boolean), `isRedirect`                            | browser same-origin `/auth/session` with the browser's own cookie                       |
| `scripts/credential-fetch.mjs`                      | `credentialFetch` for scripts                                          | no raw sender exported                                                                  |
| `packages/testing/src/guarded-http.ts`              | `guardFetch`, `guardedFetch`, `globalFetchStub`, `guardRequestContext` | no raw sender exported                                                                  |
| `packages/testing/src/redirect-probe.ts`            | `withRedirectProbe`: test servers, and `probe.fetch` = the real fetch  | **raw, by design**: for specs that stub the global; a test package (devDependency only) |
| `tests/e2e/src/http.ts`                             | `send` (refuses the five statuses), errors, types                      | no raw sender exported                                                                  |
| `tests/e2e/src/expect.ts`, `apps/web/e2e/expect.ts` | guarded `request` fixture, `newApiContext()`                           | no raw context exported                                                                 |

Live suites (`*.live-spec.ts`) are in scope: the Keycloak projection-race spec sends the
master-realm password grant and the admin bearer to the environment's `KEYCLOAK_URL`, so its
administrator calls go out on `globalFetchStub().send` (guarded, and never through the gate
the spec installs in place of the global `fetch`). Also outside what the rule sees: other
test code outside the two E2E trees (`services/*/test`, `*.spec.ts`, `__tests__`,
`apps/web/src/test`). It sends to loopback fakes, in-process applications and test
containers, with one exception: the notification-service Mailpit reads (`MAILPIT_API_URL`),
which carry no credential (GETs with no header). The document-service signed-URL helpers
there use `guardedFetch` anyway. Then a Playwright context reached by a computed member name
(`page[name]`), which cannot be told apart from ordinary indexing without types; browser flows (page navigation, `route.fetch`, code inside
`page.evaluate`, such as the pinned form replay in `apps/web/e2e/usage.spec.ts`); workspace
tooling configs (`eslint`, `jest`, `next`, `postcss` configs), which send nothing; and SDK
internals (jose JWKS, the S3 client, the OTLP exporters), as listed in the task 106 sweep.

The E2E helper transport (r1 F2): `guardedFetch` sends with `redirect: 'manual'` and
refuses the five statuses. `guardRequestContext` wraps a Playwright `APIRequestContext` so
that every sending method goes out with `maxRedirects: 0` (the caller's value overridden)
and a redirect status is refused. Without it, Playwright follows a 307/308 to another
origin with the body, keeps `authorization` on a same-origin hop, and returns the target's
success. Both harnesses' `request` fixtures and `newApiContext()` use it.
`guardFetch(sender)` is the same policy over an explicit `fetch` (`guardedFetch` is it
over the global, read at call time); `globalFetchStub()` uses it on the `fetch` captured
before a test replaces the global, for the live spec's administrator (r2 F2).
`tests/e2e/src/guarded-http.test.ts` holds the redirect regressions (307 and 308 to
another origin on every method, all five statuses on both origins, overrides,
non-redirect statuses, a control that shows an unguarded context following). One
Playwright spec per harness proves the fixture wiring.
