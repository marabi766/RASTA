/**
 * Why sealing or opening a bid failed (ADR-066).
 *
 * The messages are fixed strings. Nothing that reaches an error, a log or a
 * span may carry plaintext, a key, a nonce, a tag or any part of a ciphertext:
 * the reason is the `code`, and the caller decides what to tell whom.
 */
export const SEALING_ERROR_CODES = [
  /** No key material for this tender or KEK version (not configured, unknown version). */
  'KEY_UNAVAILABLE',
  /** The ciphertext, its tag, its associated data or its key does not verify. */
  'TAMPERED',
  /** Decrypted, but the content no longer matches the commitment made at submission. */
  'COMMITMENT_MISMATCH',
  /** The content cannot be sealed: not canonicalisable, or too large. */
  'INVALID_CONTENT',
  /** The KEK configuration is malformed. */
  'INVALID_CONFIGURATION',
] as const;

export type SealingErrorCode = (typeof SEALING_ERROR_CODES)[number];

const MESSAGES: Record<SealingErrorCode, string> = {
  KEY_UNAVAILABLE: 'The key needed for this operation is not available',
  TAMPERED: 'The sealed data does not verify',
  COMMITMENT_MISMATCH: 'The content does not match the commitment made when it was submitted',
  INVALID_CONTENT: 'The content cannot be sealed',
  INVALID_CONFIGURATION: 'The tender key configuration is not valid',
};

export class SealingError extends Error {
  readonly code: SealingErrorCode;

  constructor(code: SealingErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SealingError';
    this.code = code;
  }
}
