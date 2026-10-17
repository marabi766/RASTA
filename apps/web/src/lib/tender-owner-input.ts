import { REJECT_REASON_MAX, REJECT_REASON_MIN } from './tender-owner-fields';
import { toPersianDigits } from './format';

/**
 * A rejection's reason, read as `decisionSchema`'s `statedReason` reads it:
 * trimmed, 8 to 500 characters. Client-safe: the form and the action read it
 * the same way.
 */
export const REJECT_REASON_MESSAGE = `دلیل رد لازم است: دست‌کم ${toPersianDigits(String(REJECT_REASON_MIN))} و حداکثر ${toPersianDigits(String(REJECT_REASON_MAX))} نویسه.`;

export function parseRejectReason(
  raw: string,
):
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly message: string } {
  const reason = raw.trim();
  if (reason.length < REJECT_REASON_MIN || reason.length > REJECT_REASON_MAX) {
    return { ok: false, message: REJECT_REASON_MESSAGE };
  }
  return { ok: true, reason };
}
