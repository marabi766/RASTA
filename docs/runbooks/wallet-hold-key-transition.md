# Wallet hold key transition (PR #934, D-152)

Expand: wallet holds read the person binding and the authenticated current login's
legacy binding, scoped to the acting organization and wallet. The person copy is
authoritative: read, reserve and release consult the legacy copy as the hold only
when the person copy is absent; reserve still checks it before writing a fresh
record. Reservation writes both atomically before dispatch, with the same generation
and 30-day expiry. Either hold refuses a second dispatch. Settle and explicit release
handle both copies; release validates both atomically, answers STALE only when the
authoritative copy has another id, and deletes neither matching copy while either is
reserved. A legacy copy with another id is left untouched and appears as its own hold
on the next read after the person hold is released. An interrupted settle leaves a
hold and refuses dispatch.
Other people, organizations, wallets and former organization copies are not proofs
of ownership. Do not scan or delete arbitrary login keys to unblock a wallet.

Deployment: the real predecessor is the `origin/main` build, whose
`unresolved-request-policy.ts` has no `wallet-top-up` purpose, so it holds nothing.
Login-keyed wallet holds exist only in the open #917/#928 stack; dual copies protect
same-login compatibility with those builds, not with main. Neither main nor those
login-keyed builds can discover another login's person hold. A rollback to main
removes hold enforcement entirely.

Before rollout or rollback, the operator must put the entire web deployment behind
an upstream maintenance response (503 for all web traffic, including Server Action
POSTs), stop routing to old replicas, and drain their in-flight requests. Keep that
maintenance response in place until every serving web replica runs this
expand-capable build. Verify that no old replica receives requests before reopening
traffic. If rolling back to a build without person holds, leave web traffic blocked
until an expand-capable build is restored. There is no wallet-write switch in the
web app (`mayDispatch` gates only on the provider's demo mode); a rolling rollout
without downtime would need such a switch, which is a separate change. If the
deployment cannot enforce upstream maintenance, do not proceed.
This runbook does not install or configure that external maintenance mechanism.
Existing legacy-only holds remain protected when their authenticated login is
presented. A legacy snapshot may be unreadable; its hold stays closed and explicitly
releasable.

Contract: only after the last legacy writer/rollback target is retired, wait at
least 30 days from its last possible write (restart that clock if one runs again).
Confirm legacy-only holds have expired or were explicitly reconciled. Then a
separate reviewed change may remove login-key reads, dual writes and copy cleanup.
Do not remove reads merely because the new deployment is healthy. Already orphaned
login holds and audited operator recovery remain FU-211/FU-223; FU-222 release UI
coverage is also outside this round. Redis data loss remains an inherited limit.
