import {
  escapeHtml,
  pickLocale,
  renderEmail,
  toJalali,
  toPersianDigits,
  EmailRenderError,
  FALLBACK_LOCALE,
  type EmailTemplate,
} from './email-render';
import { contentHashOf, INSURANCE_EXPIRING_EMAIL } from './email-templates';

/**
 * What a person actually receives, and what they must never receive
 * (ADR-054 § 10).
 *
 * The three rows of NTF-004's acceptance table that concern rendering are here:
 * a missing variable fails permanently rather than leaving a blank, injected
 * markup is escaped, and a newline in a subject is stripped rather than passed
 * through. The fourth — the message on the wire — is proved against a real
 * Mailpit in `test/mail-channel.int-spec.ts`, because no unit test can say
 * what a server received.
 */

const options = { timezone: 'Asia/Tehran', locale: 'fa-IR' };

function template(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    key: 'test.template',
    version: 1,
    locale: 'fa-IR',
    subject: 'بیمهٔ {{assetId}} تا {{daysRemaining}} روز دیگر',
    body: 'دستگاه {{assetId}} در {{validTo}} منقضی می‌شود.\n\nبرای تمدید اقدام کنید.',
    variables: [
      { name: 'assetId', format: 'TEXT' },
      { name: 'daysRemaining', format: 'NUMBER' },
      { name: 'validTo', format: 'DATE' },
    ],
    ...overrides,
  };
}

const context = {
  assetId: 'AST_01J8',
  daysRemaining: 7,
  validTo: '2026-10-04T00:00:00.000Z',
};

describe('a template that cannot be filled is not sent', () => {
  it('refuses a missing variable instead of leaving a blank', () => {
    // The whole reason strict rendering exists: «بیمه‌نامهٔ شما تا  روز دیگر
    // منقضی می‌شود» is worse than a failure, because the blank travels to a
    // person who then acts on it.
    const { daysRemaining: _omitted, ...incomplete } = context;
    expect(() => renderEmail(template(), incomplete, options)).toThrow(EmailRenderError);
    try {
      renderEmail(template(), incomplete, options);
    } catch (error) {
      expect((error as EmailRenderError).reason).toBe('MISSING_VARIABLE');
      expect((error as EmailRenderError).detail).toBe('daysRemaining');
    }
  });

  it('treats an empty string as missing, not as a value', () => {
    expect(() => renderEmail(template(), { ...context, assetId: '' }, options)).toThrow(
      /MISSING_VARIABLE/,
    );
  });

  it('refuses a placeholder the template never declared', () => {
    // Undeclared means unchecked: the required-variable loop would not notice
    // it was absent, so it would render as an empty string on every message.
    const undeclared = template({ body: 'سلام {{nobodyDeclaredThis}}' });
    expect(() => renderEmail(undeclared, context, options)).toThrow(/UNDECLARED_PLACEHOLDER/);
  });
});

describe('what is interpolated cannot become markup', () => {
  it('escapes markup in the html part and leaves the text part alone', () => {
    const rendered = renderEmail(
      template(),
      { ...context, assetId: '<script>alert(1)</script>' },
      options,
    );

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    // The plain-text alternative is not markup and is not escaped into
    // something unreadable: `&lt;` in a text/plain body is shown literally.
    expect(rendered.text).toContain('<script>');
  });

  it('escapes the subject where it is reused as a heading', () => {
    const rendered = renderEmail(
      template({ subject: 'وضعیت {{assetId}}' }),
      { ...context, assetId: '<b>x</b>' },
      options,
    );
    expect(rendered.subject).toBe('وضعیت <b>x</b>');
    expect(rendered.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(rendered.html).not.toContain('<b>x</b>');
  });

  it('strips a newline in a subject rather than passing it through', () => {
    // Email header folding: a newline starts a second header, and the second
    // header an attacker chooses is `Bcc`.
    const rendered = renderEmail(
      template({ subject: 'وضعیت {{assetId}}' }),
      { ...context, assetId: 'AST\r\nBcc: victim@evil.invalid' },
      options,
    );
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject).toBe('وضعیت AST Bcc: victim@evil.invalid');
  });

  it('escapes every html metacharacter, not only the angle brackets', () => {
    expect(escapeHtml(`<&">'`)).toBe('&lt;&amp;&quot;&gt;&#39;');
  });
});

describe('the email template is the presentation layer, and only it', () => {
  it('shows numbers and dates in Persian digits', () => {
    const rendered = renderEmail(template(), context, options);
    expect(rendered.text).toContain('۷');
    expect(rendered.subject).toContain('۷');
    expect(rendered.text).not.toContain('7');
  });

  it('leaves an identifier exactly as it is, digits included', () => {
    // An asset code is read back to a person or typed into another system. A
    // Persian digit inside it makes it wrong in a way that looks like a typo.
    const rendered = renderEmail(template(), { ...context, assetId: 'AST_2026_01' }, options);
    expect(rendered.text).toContain('AST_2026_01');
    expect(rendered.text).not.toContain('AST_۲۰۲۶_۰۱');
  });

  it('shows a date on the Persian calendar, in the recipient zone', () => {
    // 2026-10-04 is 1405-07-12. Asserted as a whole string rather than by
    // parts, so a change in separator or digit set is caught too.
    expect(toJalali('2026-10-04T08:00:00.000Z', 'Asia/Tehran')).toBe('۱۴۰۵/۰۷/۱۲');
  });

  it('reads the date in the recipient zone, not the server one', () => {
    // 21:30 UTC is already tomorrow in Tehran. Telling somebody an expiry is
    // today when their calendar says tomorrow is a wrong fact, not a
    // formatting preference.
    const lateUtc = '2026-10-04T21:30:00.000Z';
    expect(toJalali(lateUtc, 'UTC')).toBe('۱۴۰۵/۰۷/۱۲');
    expect(toJalali(lateUtc, 'Asia/Tehran')).toBe('۱۴۰۵/۰۷/۱۳');
  });

  it('returns an unparseable date unchanged rather than guessing', () => {
    expect(toJalali('not-a-date', 'Asia/Tehran')).toBe('not-a-date');
  });

  it('converts only the digits it is given', () => {
    expect(toPersianDigits('1405/07/12')).toBe('۱۴۰۵/۰۷/۱۲');
    expect(toPersianDigits('AST_1')).toBe('AST_۱');
  });
});

describe('the document a mail client receives', () => {
  it('declares right-to-left and Persian on the root element', () => {
    const rendered = renderEmail(template(), context, options);
    expect(rendered.html).toContain('<html dir="rtl" lang="fa-IR">');
  });

  it('uses logical css properties, never physical ones', () => {
    // The same rule CLAUDE.md sets for the web app. A `margin-left` here puts
    // the accent on the wrong edge the day anything renders left-to-right.
    const { html } = renderEmail(template(), context, options);
    expect(html).toMatch(/margin-inline|padding-inline|border-inline-start|text-align: start/);
    expect(html).not.toMatch(/margin-left|margin-right|padding-left|padding-right/);
  });

  it('turns blank lines into paragraphs and keeps both parts in step', () => {
    const rendered = renderEmail(template(), context, options);
    expect((rendered.html.match(/<p>/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(rendered.text).toContain('برای تمدید اقدام کنید.');
  });
});

describe('locale selection', () => {
  it('prefers the exact locale, falls back to fa-IR, then gives up', () => {
    expect(pickLocale(['fa-IR', 'en-US'], 'en-US')).toBe('en-US');
    expect(pickLocale(['fa-IR'], 'en-US')).toBe(FALLBACK_LOCALE);
    // Never a half-translated message: no locale at all is a permanent
    // failure, not an excuse to send the first row found.
    expect(pickLocale(['de-DE'], 'en-US')).toBeNull();
  });
});

describe('the shipped catalogue', () => {
  it('renders with the context its rule actually collects', () => {
    // The rule's `contextAllowlist` is what reaches `contextData`; a template
    // requiring anything outside it could never render in production and
    // would only be discovered by somebody not receiving an email.
    const rendered = renderEmail(
      INSURANCE_EXPIRING_EMAIL,
      {
        assetId: 'AST_1',
        insurerName: 'بیمهٔ ایران',
        validTo: '2026-10-04T00:00:00.000Z',
        daysRemaining: 7,
      },
      options,
    );
    expect(rendered.subject).toContain('AST_1');
    expect(rendered.text).toContain('بیمهٔ ایران');
  });

  it('hashes content and not identity', () => {
    const a = contentHashOf(INSURANCE_EXPIRING_EMAIL);
    // A different version number is the same text: the hash must not move, or
    // publishing v2 of an unchanged template would look like an edit.
    expect(contentHashOf({ ...INSURANCE_EXPIRING_EMAIL, version: 9 })).toBe(a);
    // Reordering the declared variables changes nothing anybody reads.
    expect(
      contentHashOf({
        ...INSURANCE_EXPIRING_EMAIL,
        variables: [...INSURANCE_EXPIRING_EMAIL.variables].reverse(),
      }),
    ).toBe(a);
    // Changing one character of the text does.
    expect(contentHashOf({ ...INSURANCE_EXPIRING_EMAIL, subject: 'x' })).not.toBe(a);
  });
});
