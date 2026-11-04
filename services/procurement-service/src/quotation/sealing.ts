import { QUOTATION_RECEIPT_GENESIS_LABEL } from '@rasta/contracts';
import { SealingScheme, type SealingLabels } from '@rasta/sealing';

/**
 * The domain-separation labels of a quotation (ADR-070 § 4; plan PR 4: procurement puts its own
 * labels on the shared `@rasta/sealing`, so a quotation's bytes are never a bid's). **Part of every
 * commitment, digest and receipt already issued** — never change one. The genesis label is the one
 * audit-service recomputes the RFQ chain's genesis with (`RFQ_RECEIPT_GENESIS_LABEL`, bytes pinned
 * there) and the migration recomputes too (`quotation_receipt_genesis`).
 */
export const QUOTATION_SEALING_LABELS: SealingLabels = Object.freeze({
  associatedData: 'rasta.quotation.aad.v1',
  commitment: 'rasta.quotation.commitment.v1',
  ciphertext: 'rasta.quotation.ciphertext.v1',
  receiptGenesis: QUOTATION_RECEIPT_GENESIS_LABEL,
  receipt: 'rasta.quotation.receipt.v1',
});

/** An RFQ is the scheme's scope, a quotation its entry, the supplier organization its submitter. */
export const QUOTATION_SEALING = new SealingScheme(QUOTATION_SEALING_LABELS);
