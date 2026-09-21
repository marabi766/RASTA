import { classify, refuseUnsendable, stripNewlines } from './smtp.mail.channel';
import type { MailMessage } from './mail.channel.port';

/**
 * The parts of the SMTP adapter that decide something, tested as pure
 * functions.
 *
 * Nodemailer is not stubbed here and the class is not constructed: what is
 * under test is the header-injection refusal and the retry classification, and
 * both are decisions this repository makes rather than behaviour the library
 * provides. The adapter's actual conversation with a server is proved against
 * a real Mailpit in `test/mail-channel.int-spec.ts` — a mocked SMTP server
 * would only prove that the mock was called.
 */

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: 'someone@example.invalid',
    subject: 'بیمهٔ خودرو رو به انقضاست',
    html: '<p>سلام</p>',
    text: 'سلام',
    ...overrides,
  };
}

describe('what the adapter refuses to send', () => {
  it('refuses a recipient carrying a newline — that is a second header', () => {
    expect(refuseUnsendable(message({ to: 'a@b.invalid\r\nBcc: victim@c.invalid' }))).toBe(
      'INVALID_MESSAGE',
    );
    expect(refuseUnsendable(message({ to: 'a@b.invalid\nBcc: victim@c.invalid' }))).toBe(
      'INVALID_MESSAGE',
    );
  });

  it('gives the same answer every time it is asked', () => {
    // The guard used to share one `/g` regular expression with the subject
    // stripper. A global regular expression carries `lastIndex` between
    // `test()` calls, so the same address alternated between refused and
    // accepted — a guard that fails on every other call is worse than none,
    // because the calls it fails on are the ones nobody watches.
    const injected = message({ to: 'a@b.invalid\r\nBcc: victim@c.invalid' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(refuseUnsendable(injected)).toBe('INVALID_MESSAGE');
    }
  });

  it('refuses a second recipient, however it is spelled', () => {
    // Not a style rule: a delivery in this service is one row per person, so a
    // list has no row to belong to, and it is how one template bug tells
    // everybody who else was notified.
    expect(refuseUnsendable(message({ to: 'a@b.invalid, c@d.invalid' }))).toBe('INVALID_MESSAGE');
    expect(refuseUnsendable(message({ to: 'a@b.invalid; c@d.invalid' }))).toBe('INVALID_MESSAGE');
  });

  it('refuses an empty recipient, an empty subject and a shapeless address', () => {
    expect(refuseUnsendable(message({ to: '   ' }))).toBe('INVALID_MESSAGE');
    expect(refuseUnsendable(message({ subject: '   ' }))).toBe('INVALID_MESSAGE');
    expect(refuseUnsendable(message({ to: 'not-an-address' }))).toBe('INVALID_MESSAGE');
  });

  it('accepts an ordinary Persian message', () => {
    expect(refuseUnsendable(message())).toBeNull();
  });
});

describe('subject newlines are stripped rather than passed through', () => {
  it('collapses CR, LF and CRLF into a space', () => {
    expect(stripNewlines('اعلان\r\nBcc: victim@evil.invalid')).toBe(
      'اعلان Bcc: victim@evil.invalid',
    );
    expect(stripNewlines('یک\nدو')).toBe('یک دو');
  });

  it('leaves an ordinary subject alone', () => {
    expect(stripNewlines('بیمهٔ خودرو رو به انقضاست')).toBe('بیمهٔ خودرو رو به انقضاست');
  });
});

describe('which failures are worth trying again', () => {
  it('treats SMTP 4xx as transient and 5xx as permanent', () => {
    // The line ADR-054 § 7 draws: 4xx is "not now", 5xx is "not ever", and
    // re-sending the second turns one rejected message into five.
    expect(classify({ responseCode: 451 }).outcome).toBe('TRANSIENT_FAILURE');
    expect(classify({ responseCode: 421 }).outcome).toBe('TRANSIENT_FAILURE');
    expect(classify({ responseCode: 550 }).outcome).toBe('PERMANENT_FAILURE');
    expect(classify({ responseCode: 552 }).outcome).toBe('PERMANENT_FAILURE');
  });

  it('names the reason, not the server text', () => {
    expect(classify({ responseCode: 550 }).reason).toBe('RECIPIENT_REJECTED');
    expect(classify({ responseCode: 535 }).reason).toBe('AUTHENTICATION_FAILED');
    expect(classify({ code: 'ECONNREFUSED' }).reason).toBe('CONNECTION_FAILED');
    expect(classify({ code: 'ETIMEDOUT' }).reason).toBe('TIMEOUT');
    // `ESOCKET` is what nodemailer actually raises for a refused connection —
    // established by the integration suite against a dead port, not guessed.
    // It used to be labelled `TIMEOUT`, which sent an operator looking for a
    // slow server instead of an absent one.
    expect(classify({ code: 'ESOCKET' }).reason).toBe('CONNECTION_FAILED');
  });

  it('treats an unrecognised failure as transient', () => {
    // Deliberate, and stated so it is not "fixed" later: calling an unknown
    // failure permanent discards a message nobody decided to discard, while
    // calling it transient costs a retry and a bounded backoff.
    expect(classify(new Error('something nobody has seen')).outcome).toBe('TRANSIENT_FAILURE');
    expect(classify(null).outcome).toBe('TRANSIENT_FAILURE');
    expect(classify(undefined).outcome).toBe('TRANSIENT_FAILURE');
  });
});
