import { REJECT_REASON_MESSAGE, parseRejectReason } from './tender-owner-input';

/** A rejection's reason, as `statedReason` reads it: trimmed, 8 to 500 characters. */

it('takes a reason of 8 to 500 characters, trimmed', () => {
  expect(parseRejectReason('  معیارها کامل نیست  ')).toEqual({
    ok: true,
    reason: 'معیارها کامل نیست',
  });
  expect(parseRejectReason('x'.repeat(500))).toEqual({ ok: true, reason: 'x'.repeat(500) });
});

it('refuses a reason too short, blank or too long', () => {
  for (const raw of ['کوتاه', '        ', 'x'.repeat(501)]) {
    expect(parseRejectReason(raw)).toEqual({ ok: false, message: REJECT_REASON_MESSAGE });
  }
});
