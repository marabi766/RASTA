import { z } from 'zod';

/**
 * zod 3's `.url()`, kept after the move to zod 4 (GHSA-mrhx-c7xc-m3w5): a
 * string the WHATWG URL parser accepts, **returned exactly as written**.
 *
 * zod 4's `.url()` trims the value and strips tabs and newlines from what it
 * returns, so a value parsed today and the same value parsed after the bump
 * would differ — in a stored setting, a compared reference, a hash. This is
 * zod 4's own URL format (issue `invalid_format`/`url`, zod 3's "Invalid url";
 * OpenAPI `format: uri`) with zod 3's check: `new URL(value)`, value untouched.
 *
 * Use it where `.url()` was: `z.string().check(parsableUrl())`.
 */
export function parsableUrl(params?: { message?: string }): z.core.$ZodCheck<string> {
  const check = z.core._url(z.ZodURL, params ?? {});
  check._zod.check = (payload) => {
    try {
      new URL(payload.value);
    } catch {
      payload.issues.push({
        code: 'invalid_format',
        format: 'url',
        input: payload.value,
        inst: check,
        continue: true,
      });
    }
  };
  return check;
}
