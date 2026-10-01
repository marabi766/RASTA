/**
 * The hidden fields every writing form carries.
 *
 * They live here, and not beside the code that mints or checks them, for a
 * reason the build enforces: the form is a client component, `session.ts` and
 * `submission.ts` import `node:crypto`, and a client component that imported
 * either would pull Node's crypto into the browser bundle — which Next
 * refuses to compile, and rightly. Two string constants are the only thing
 * both sides need to agree on.
 *
 * Their meaning is documented where they are used: `server/csrf.ts` for the
 * token, `server/submission.ts` for the id.
 */

export const CSRF_FIELD = 'csrf';
export const SUBMISSION_FIELD = 'submission';

/**
 * The query parameter a redirect after a write carries its confirmation in
 * (`server/flash.ts`): a short-lived token the server can verify, never a
 * `?created=1` anybody could type.
 */
export const FLASH_PARAM = 'flash';

/**
 * The hidden field of the edit form that carries what the person was shown
 * (`server/asset-baseline.ts`): signed, so the action diffs against the values
 * the server rendered rather than against anything the browser claims.
 */
export const BASELINE_FIELD = 'baseline';
