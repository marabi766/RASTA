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
