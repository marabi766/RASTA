# Wallet hold key transition (PR #934, D-152)

Expand: wallet holds read the person binding and the authenticated current login's
legacy binding, scoped to the acting organization and wallet. Reservation checks
both and writes both atomically before dispatch, with the same generation and
30-day expiry. Either hold refuses a second dispatch. Settle and explicit release
handle both copies; an interrupted operation leaves a hold and refuses dispatch.
Other people, organizations, wallets and former organization copies are not proofs
of ownership. Do not scan or delete arbitrary login keys to unblock a wallet.

Deployment: keep dual reads and writes throughout rollout and the rollback window.
The legacy copy lets an old replica serving the same login see a new hold. An old
replica cannot discover a different login's person hold; old-only logins cannot be
enumerated from these hashed keys. Therefore drain old wallet write traffic before
allowing login changes or another device through old replicas. A rollback must keep
wallet writes closed until an expand-capable build serves them. This is a deployment
prerequisite, not a guarantee supplied by the old binary. Existing legacy-only
holds remain protected when their authenticated login is presented. A legacy
snapshot may be unreadable; its hold stays closed and explicitly releasable.

Contract: only after the last legacy writer/rollback target is retired, wait at
least 30 days from its last possible write (restart that clock if one runs again).
Confirm legacy-only holds have expired or were explicitly reconciled. Then a
separate reviewed change may remove login-key reads, dual writes and copy cleanup.
Do not remove reads merely because the new deployment is healthy. Already orphaned
login holds and audited operator recovery remain FU-211/FU-223; FU-222 release UI
coverage is also outside this round. Redis data loss remains an inherited limit.
