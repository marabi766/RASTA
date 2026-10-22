/**
 * The sentence every tender command that keeps its first answer by `Idempotency-Key` carries
 * (task 060, docs/06 § 6.8). The OpenAPI document declares the header and its 409s on the same routes
 * (`IDEMPOTENT` in `src/openapi/document.ts`).
 */
export const RETRY_NOTE =
  'An optional Idempotency-Key (the gateway always sends one) makes a retry return the first ' +
  'answer — its status included — and do nothing again: a retry whose first attempt committed but ' +
  'whose answer was lost is that answer, even if the tender has moved on since. The key is the ' +
  'organization’s and the request names the caller: the same key with another body, or from another ' +
  'person, is 409 IDEMPOTENCY_KEY_REUSED; while the first is in flight, 409 CONFLICT with Retry-After. ' +
  'It is claimed only once the caller is authorised; a refused request keeps nothing.';
