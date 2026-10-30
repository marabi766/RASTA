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
  production code (every path `isTestOnlyPath` in
  `scripts/testing-dev-only.mjs` does not name) the rule also refuses:
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

  Test-only code (root `scripts/`, `tests/`, test trees, `packages/testing`)
  is never in an image, and no production file may import it (`testing/dev-only`,
  PR #514). There the run-time boundary alone answers loaders.

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

| Config                            | Exemption                                                                                                  | Reason                                                                                       | Why production cannot reach it                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| root `INTERNAL_TOKEN_SOURCE`, web | rule `off` for `*.spec.*`, `*.int-spec.ts`, `*.e2e-spec.ts`, `*.test.*`, `test/**`                         | test token factories exercise the services' guards                                           | test-only by `isTestOnlyPath`; `testing/dev-only` refuses any production import of a test-only file, extensionless TypeScript imports included |
| root, allow `header`              | `send()` in `tests/e2e/src/http.ts`                                                                        | the E2E transport (no nest-common dependency) sets the header behind its redirect hand guard | `tests/` is test-only                                                                                                                          |
| root, allow `signer`              | `mintInternalToken()` in `tests/e2e/src/internal.ts`                                                       | the E2E harness signs the wire format itself                                                 | `tests/` is test-only                                                                                                                          |
| root, allow `signer`              | `e2eConfig()` in `tests/e2e/src/env.ts`                                                                    | the harness reads the secret by name from its environment                                    | `tests/` is test-only                                                                                                                          |
| root, allow `signer`              | `mintTestInternalToken()` in `packages/testing/src/internal-token.ts`                                      | the services' test factories mint here (PR #514)                                             | devDependency only; checked in source, in the production dependency graph and in images (`scripts/testing-dev-only.mjs`)                       |
| root, allow `signer`              | `secretName()` in `scripts/internal-token-source-rule.mjs`                                                 | the rule names the secret it refuses                                                         | root `scripts/` is test-only                                                                                                                   |
| root, web, e2e                    | global ignores (`node_modules`, `dist`, `.next`, `.turbo`, `coverage`, `src/generated`, Playwright output) | build output and generated code                                                              | linted by the coverage test below when tracked                                                                                                 |
| nest-common                       | the client file itself (`internal-http-client.ts`)                                                         | holds the issuer, `mint()` and the header                                                    | it is the boundary                                                                                                                             |

The coverage tests in `scripts/internal-token-source-workspace.test.mjs` derive
this from ESLint itself, not from directory prefixes. For every tracked JS/TS
file they ask each lint script's ESLint whether it lints the file, and at which
level:

- every file linted with the rule off must be test-only;
- every allowance must name a test-only file;
- every file no lint script reaches is linted there with the rule itself,
  without types and with inline configuration off. These are config files,
  `apps/web/e2e/**` and ignored paths. This replaces r1's spelling scan, which
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
| r2 F4: exempt helper imported by production; unlinted generic wrapper; ignored paths                                                                                               | `issue()` throws                               | "review F4…" (refused by `testing/dev-only`), both coverage tests                               |

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
