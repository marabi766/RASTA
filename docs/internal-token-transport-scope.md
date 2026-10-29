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

**Status after task 135 (PR #492 round 2):** the _transport_ half of every row is closed by
the boundary below. Outside the audited files no raw sender can be reached at all, so it does
not matter where the headers were built (row 1) or how the transport was aliased (rows 2–8);
dev, seed and both E2E trees are covered (row 9). Each row has a failing fixture in
`scripts/raw-http-boundary-rule.test.mjs`, under the real workspace configs too. The
_token-source_ half (who may call `InternalTokenService.issue`, and where the internal header
may be built) is a separate question from redirects and **stays open** as written above.

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

Temporary exemption: `services/identity-service/src/keycloak/keycloak.client.ts` still
sends its client secret and admin bearer with raw `fetch` on `main`. PR #483 moves all
three exchanges to `internalFetch`. Until then, `services/identity-service/eslint.config.mjs`
exempts that one file. `internal-token-transport-workspace.test.mjs` proves the exemption
is limited to it and fails once the file uses `internalFetch` with the exemption still in place.

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
are not scenarios and are excluded). The portal's lint now includes `e2e`. A real-config
test computes the rule for every in-scope tracked file (more than a thousand) in its own
workspace and checks that the workspace's lint script reaches it. Another test holds inline
disables of either rule to one pinned line. The credential rule stays on as a second layer.

`AUDITED_TRANSPORTS`: exact files, never directories. A test checks that each entry exists,
has a reason, and that the list equals a pinned copy. An exempt file is exempt only as that
file. **What each one exports is reviewed by hand**; the boundary cannot follow a raw sender
handed out of an audited file:

| Audited file                                        | What it exports                                                       | Reviewed                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/nest-common/src/http/internal-fetch.ts`   | `internalFetch` (refuses the five statuses)                           | no raw sender exported                                                                  |
| `apps/web/src/server/credential-fetch.ts`           | `credentialFetch`, its error                                          | no raw sender exported                                                                  |
| `apps/web/src/server/signed-url-upload.ts`          | `putToSignedUrl` (`redirect: 'error'`, set after the caller's init)   | no raw sender exported                                                                  |
| `apps/web/src/lib/session-refusal.ts`               | `sessionHasEnded` (a boolean), `isRedirect`                           | browser same-origin `/auth/session` with the browser's own cookie                       |
| `scripts/credential-fetch.mjs`                      | `credentialFetch` for scripts                                         | no raw sender exported                                                                  |
| `packages/testing/src/guarded-http.ts`              | `guardedFetch`, `guardRequestContext`                                 | no raw sender exported                                                                  |
| `packages/testing/src/redirect-probe.ts`            | `withRedirectProbe`: test servers, and `probe.fetch` = the real fetch | **raw, by design**: for specs that stub the global; a test package (devDependency only) |
| `tests/e2e/src/http.ts`                             | `send` (refuses the five statuses), errors, types                     | no raw sender exported                                                                  |
| `tests/e2e/src/expect.ts`, `apps/web/e2e/expect.ts` | guarded `request` fixture, `newApiContext()`                          | no raw context exported                                                                 |

Also outside what the rule sees: test code outside the two E2E trees (`services/*/test`,
`*.spec.ts`, `__tests__`, `apps/web/src/test`, which talk to loopback fakes; the
document-service signed-URL helpers there use `guardedFetch` anyway); a Playwright context
reached by a computed member name (`page[name]`), which cannot be told apart from ordinary
indexing without types; browser flows (page navigation, `route.fetch`, code inside
`page.evaluate`, such as the pinned form replay in `apps/web/e2e/usage.spec.ts`); workspace
tooling configs (`eslint`, `jest`, `next`, `postcss` configs), which send nothing; and SDK
internals (jose JWKS, the S3 client, the OTLP exporters), as listed in the task 106 sweep.

The E2E helper transport (r1 F2): `guardedFetch` sends with `redirect: 'manual'` and
refuses the five statuses. `guardRequestContext` wraps a Playwright `APIRequestContext` so
that every sending method goes out with `maxRedirects: 0` (the caller's value overridden)
and a redirect status is refused. Without it, Playwright follows a 307/308 to another
origin with the body, keeps `authorization` on a same-origin hop, and returns the target's
success. Both harnesses' `request` fixtures and `newApiContext()` use it.
`tests/e2e/src/guarded-http.test.ts` holds the redirect regressions (307 and 308 to
another origin on every method, all five statuses on both origins, overrides,
non-redirect statuses, a control that shows an unguarded context following). One
Playwright spec per harness proves the fixture wiring.
