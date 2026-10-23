# Manual tender procurement thresholds (Q-03, 2026-10-23)

The owner chooses `Tender.procurementNature`; the platform never chooses or defaults it and makes no
legal determination. The tender has its own optional `estimatedCostMinor`, an integer string in rial.
A project estimate is not substituted for a tender estimate.

The organization governance key is `construction.tender.procurement_thresholds`. Its value contains
exactly `FORMAL_TENDER`, `INQUIRY`, `RFP`, and `MARKETPLACE_DEAL`; each entry has
`minAmountMinor`, `maxAmountMinor` (integer rial strings, or null for an unbounded end), and
`mode` (`WARN` or `REJECT`). Bounds are inclusive; minimum must not exceed maximum. Supply actual
amounts from the employer's procurement bylaws through the existing organization policy workflow,
which retains its setter roles, audit, validity periods, nearest-ancestor inheritance and overrides.
No threshold amounts are seeded. No sample table is installed.

The consumer contract is `GET /v1/organizations/{id}/procurement-thresholds`, with a construction-service
internal token signed for exactly that organization. The narrow answer is
`{ organizationId, policy: { id, value } }`, or `{ organizationId, policy: null }` when no effective table
exists. Service callers only: construction-service is the sole allowed service; person/session
callers and other services receive 403. A token for any other organization receives a generic 404,
even when that organization is an ancestor of the requested id. No other governance key is returned.

Construction reads the effective policy before taking a row lock, on each new publish attempt, including
execution after approval. This is a point-in-time policy read; a policy changed after that read governs
the next attempt. No table means no estimate check. A present table requires an estimate; absent
estimates are refused with 422 `BUSINESS_RULE_VIOLATION` and details code
`PROCUREMENT_ESTIMATE_REQUIRED`. An out-of-range REJECT answers the same 422 with
`PROCUREMENT_AMOUNT_OUTSIDE_RANGE`. Malformed or unavailable policy responses fail closed with
503/504; a 404 is not treated as no configuration.

An out-of-range WARN allows publication after its normal approval gate, preserves the manual choice,
and returns `procurementThresholdWarning: "PROCUREMENT_AMOUNT_OUTSIDE_RANGE"` on the executed
publication result and owner detail. The tender retains the warning and policy id even if configuration
later changes. The web owner screen displays a fixed Persian warning explaining that this is no legal
judgment. A 202 approval request is not publication; the persisted warning is written on execution.

Both amount and nature can change only in DRAFT. Publication checks their current locked values;
changes invalidate existing approvals through the existing tender version checks. After publication,
service validation and a database trigger freeze both fields and the warning snapshot. There is no
post-publication amount/nature edit path to revalidate.

WARN is audited through optional closed-code and policy-id metadata on the transactional
`TENDER_PUBLISHED` event. REJECT uses the existing separate best-effort refusal transaction and
`TENDER_APPROVAL_ACTION` event. No amounts are placed on audit events or refusal error messages.
The same audit availability limitation as other approval-gate refusals applies.
