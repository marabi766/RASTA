/**
 * What this service accepts as an `Idempotency-Key`: 1–255 printable ASCII
 * characters, no spaces — a key, not a message. One definition for every
 * command that requires one (the audit correction, user provisioning).
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
