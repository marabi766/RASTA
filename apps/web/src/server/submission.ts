import { randomBytes } from 'node:crypto';

import { SUBMISSION_FIELD } from '@/lib/form-fields';

/**
 * One id per form, minted when the form is rendered, spent when it is
 * accepted.
 *
 * It is what makes a double-click, a retried timeout, or a tablet that syncs
 * the same reading twice produce **one** record instead of two. The portal
 * sends it in both shapes the platform understands: as the `Idempotency-Key`
 * header, which the gateway demands on the prefixes with financial or
 * irreversible effects (docs/06 § 6.8), and as the body's `clientReference`
 * where a service dedupes at the record level, as `usage-records` does. The
 * service is the authority on what "the same submission" means; the portal's
 * job is to say the same thing both times, which is exactly what a fresh id
 * on every render and the same id on every retry gives it.
 *
 * Minted on the server, so a form that was rendered is a form that already
 * has one — the no-JavaScript submission carries it like any other field.
 */

/** Twenty base64url characters of entropy behind a prefix that says what it is. */
const PREFIX = 'sub_';
const ENTROPY_BYTES = 15;

export function newSubmissionId(): string {
  return `${PREFIX}${randomBytes(ENTROPY_BYTES).toString('base64url')}`;
}

/**
 * The shape the server accepts back.
 *
 * Fixed length and alphabet, so a client cannot choose an id that is short
 * enough to collide on purpose or long enough to exceed what a service stores
 * (`clientReference` is bounded at 8–128 characters).
 */
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{20}$/;

export function isSubmissionId(value: unknown): value is string {
  return typeof value === 'string' && SUBMISSION_ID.test(value);
}

export { SUBMISSION_FIELD };
