import type { ClaimStatus } from '../asset/dto';

/**
 * What a claim takes in the way of documents (docs/24 Q-128, temporary).
 *
 * The product document sets neither number nor window, so both come from
 * configuration (AGENTS.md § 9) and the defaults are the conservative reading:
 * twenty references, only while the claim is open. Widening either is a
 * deployment change, not a code change.
 */
export interface ClaimAttachmentPolicy {
  /** The most references one claim holds. */
  readonly maxDocuments: number;
  /** The claim statuses in which a document may still be attached. */
  readonly statusesAllowingAttach: readonly ClaimStatus[];
}

export const DEFAULT_CLAIM_ATTACHMENT_POLICY: ClaimAttachmentPolicy = {
  maxDocuments: 20,
  statusesAllowingAttach: ['SUBMITTED', 'UNDER_REVIEW'],
};
