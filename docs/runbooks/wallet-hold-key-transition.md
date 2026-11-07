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

Deployment: the real predecessor is the `origin/main` build (#917/#928), whose
`unresolved-request-policy.ts` already has a login-keyed `wallet-top-up` purpose.
Dual copies keep a same-login hold visible to main during a mixed rollout or a
rollback, but only while that login's session lasts: logout purges the login copy
(`purgeUnresolved`), and a rollback to main afterwards no longer sees the person
hold. Main cannot discover another login's person hold (as before), and a
login-keyed hold written by main is not visible to a different login of the same
person until it is released or expires (FU-211/FU-223). A top-up hold that main
wrote under a pre-task-100 former-organization copy is not read by this build
(`formerKeysFor` returns null for person purposes); it needs a sealed cookie from
before task 100 and a hold created after #917, so it is accepted as a residual.
A top-up snapshot is sealed under the acting organization in this build and under the
login in main, so across a mixed rollout or a rollback the hold stays (and refuses
dispatch) but its saved amount is unreadable: the screen shows "not checked" with the
release control, never a resend.

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
