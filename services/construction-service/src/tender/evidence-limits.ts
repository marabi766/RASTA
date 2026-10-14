/**
 * The most links audit-service returns of one tender's receipt chain: its `MAX_CHAIN_LINKS`
 * (`services/audit-service/src/audit/tender-evidence.repository.ts`), declared here because a
 * service never imports another's code. A chain longer than this is refused there, not cut, so a
 * tender with more receipts could never be opened (construction audit F2):
 * `CONSTRUCTION_TENDER_MAX_RECEIPTS` may not exceed it, and a unit test pins the two together.
 *
 * At about 450 bytes a link, 10,000 links are well within `MAX_CHAIN_BYTES` (8 MiB).
 */
export const EVIDENCE_MAX_CHAIN_LINKS = 10_000;
