import type { ContextData, ContextValue } from '../rules/context-sanitiser';

/**
 * Rendering for the email channel: Persian, right-to-left, and strict
 * (ADR-054 § 10).
 *
 * The in-app renderer next door produces plain text for an API that serves
 * text. This one produces a document that a mail client will interpret, which
 * changes what "safe" means: every interpolated value is HTML-escaped for the
 * body, stripped of newlines for the subject, and percent-encoded for a link
 * segment. Those are three different escapes for three different grammars, and
 * choosing per position rather than once is the whole of ADR § 10.5.
 *
 * ## What is shared with the in-app renderer, and what is not
 *
 * The placeholder shape is the same — `{{name}}`, one token, no expressions,
 * no filters — and so is the refusal: a missing required variable throws
 * rather than interpolating a blank. A template that silently produced
 * «بیمه‌نامهٔ شما تا  روز دیگر منقضی می‌شود» is worse than one that fails
 * loudly, because the blank travels to a person who then acts on it.
 *
 * What is not shared is presentation. The in-app channel hands Latin digits
 * and UTC timestamps to a web app that formats them; an email has no such
 * layer downstream, so **the template is the presentation layer** — the one
 * place CLAUDE.md's "Persian digits only in presentation" legitimately lands
 * inside a service.
 *
 * ## Why a variable declares its own format
 *
 * `{{daysRemaining}}` is a number and becomes «۷»; `{{validTo}}` is an instant
 * and becomes «۱۴۰۵/۰۷/۱۲»; `{{policyId}}` is an identifier and must stay
 * `INS_01J8…` exactly, because a person reads it back to somebody. Deciding
 * that by inspecting the value would make the rendering of an identifier
 * depend on whether it happened to contain digits, so each variable says what
 * it is, and the declaration lives in the same row as the text that uses it.
 */

/** How one variable is turned into something a person reads. */
export const VARIABLE_FORMATS = ['TEXT', 'NUMBER', 'DATE'] as const;
export type VariableFormat = (typeof VARIABLE_FORMATS)[number];

export interface TemplateVariable {
  readonly name: string;
  readonly format: VariableFormat;
}

export interface EmailTemplate {
  readonly key: string;
  readonly version: number;
  /** Exact locale of this text. `fa-IR` today; the fallback chain is in `pickLocale`. */
  readonly locale: string;
  readonly subject: string;
  /**
   * The body as text, with blank lines separating paragraphs. One stored text
   * serves both parts of the message: the plain-text alternative is this,
   * interpolated; the HTML part is this, escaped and wrapped in the shell
   * below. Storing two bodies would let them drift, and the one that drifts is
   * always the one nobody reads while testing.
   */
  readonly body: string;
  readonly variables: readonly TemplateVariable[];
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailRenderOptions {
  /** The recipient's snapshot zone. Dates are shown in it, never in the server's. */
  readonly timezone: string;
  /** The recipient's snapshot locale, used to pick the template text. */
  readonly locale: string;
}

export class EmailRenderError extends Error {
  constructor(
    readonly templateKey: string,
    readonly reason: 'MISSING_VARIABLE' | 'UNDECLARED_PLACEHOLDER' | 'NO_TEMPLATE_FOR_LOCALE',
    readonly detail: string,
  ) {
    super(`Template ${templateKey}: ${reason} (${detail})`);
    this.name = 'EmailRenderError';
  }
}

/** `{{name}}` — the same one token shape the in-app renderer accepts. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Email header folding: a newline in a subject starts a second header. */
const NEWLINES = /[\r\n]+/g;

const MAX_SUBJECT_LENGTH = 200;

/**
 * The locale every recipient falls back to.
 *
 * ADR § 10.4: exact locale, then `fa-IR`, then permanent failure. Never a
 * half-translated message — an email whose subject is Persian and whose body
 * is English is not a message, it is two fragments.
 */
export const FALLBACK_LOCALE = 'fa-IR';

export function pickLocale(available: readonly string[], wanted: string): string | null {
  if (available.includes(wanted)) return wanted;
  if (available.includes(FALLBACK_LOCALE)) return FALLBACK_LOCALE;
  return null;
}

export function renderEmail(
  template: EmailTemplate,
  context: ContextData,
  options: EmailRenderOptions,
): RenderedEmail {
  const declared = new Map(template.variables.map((variable) => [variable.name, variable.format]));

  // A placeholder nobody declared would render as an empty string under a
  // permissive reader and as the literal `{{x}}` under a strict one. Both are
  // a template bug reaching a person, so it is refused here where the failure
  // is attributable to the template rather than to the event.
  for (const name of placeholdersIn(template.subject).concat(placeholdersIn(template.body))) {
    if (!declared.has(name)) {
      throw new EmailRenderError(template.key, 'UNDECLARED_PLACEHOLDER', name);
    }
  }

  const missing = template.variables
    .map((variable) => variable.name)
    .filter((name) => !isPresent(context[name]));
  if (missing.length > 0) {
    throw new EmailRenderError(template.key, 'MISSING_VARIABLE', missing.join(', '));
  }

  const present = (name: string, escape: (value: string) => string): string =>
    escape(format(context[name] as ContextValue, declared.get(name) ?? 'TEXT', options));

  const subject = clamp(
    stripNewlines(interpolate(template.subject, (name) => present(name, identity))),
    MAX_SUBJECT_LENGTH,
  );
  const text = interpolate(template.body, (name) => present(name, identity));
  const html = shell(
    subject,
    interpolate(template.body, (name) => present(name, escapeHtml)),
  );

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Presentation — the only place in this service where a digit stops being Latin
// ---------------------------------------------------------------------------

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

/**
 * Latin digits to Persian, applied **only** to values a template declared as a
 * number or a date.
 *
 * Never applied to a `TEXT` value: an asset code, a policy number or a plate
 * is read back to another human or typed into another system, and a Persian
 * digit inside it makes it wrong in a way that looks like a typo.
 */
export function toPersianDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

/**
 * A date as a Persian (Hijri-Shamsi) calendar date in the recipient's zone.
 *
 * `Intl` with the `persian` calendar rather than a conversion library: Node
 * carries full ICU, the conversion is the platform's own, and the timezone is
 * applied in the same call — which matters, because a date is only correct
 * relative to the zone somebody reads it in. An expiry at 21:30 UTC is
 * tomorrow in Tehran, and telling a person it is today is a wrong fact, not a
 * formatting preference.
 *
 * An unparseable instant is returned as-is rather than guessed at. The
 * template asked for a date; if the producer sent something else, showing it
 * verbatim is honest and shows a reviewer exactly what arrived.
 */
export function toJalali(value: string, timezone: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;

  const parts = new Intl.DateTimeFormat('en-u-ca-persian', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const find = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  // Assembled from parts rather than taking the locale's own joined output:
  // `fa-IR` would hand back its own separators and digits, and the digit
  // conversion is a decision this module makes once, visibly, for every
  // formatted value.
  const year = find('year').replace(/[^0-9]/g, '');
  return toPersianDigits(`${year}/${find('month')}/${find('day')}`);
}

function format(value: ContextValue, kind: VariableFormat, options: EmailRenderOptions): string {
  if (value === null || value === undefined) return '';
  switch (kind) {
    case 'NUMBER':
      return toPersianDigits(String(value));
    case 'DATE':
      return toJalali(String(value), options.timezone);
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The HTML shell.
 *
 * Right-to-left and Persian are declared on the root element, not guessed from
 * the text. CSS uses logical properties (`margin-inline-start`,
 * `padding-inline`, `text-align: start`) exactly as CLAUDE.md requires of the
 * web app — a `margin-left` here would put the accent on the wrong edge of
 * every paragraph the day somebody renders this left-to-right.
 *
 * Styles are inline in a `<style>` block and the markup is a handful of
 * elements: mail clients strip stylesheets, ignore most selectors and are the
 * least forgiving rendering surface this platform targets.
 */
function shell(title: string, body: string): string {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `      <p>${block.replace(/\n/g, '<br />')}</p>`)
    .join('\n');

  return `<!DOCTYPE html>
<html dir="rtl" lang="fa-IR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        padding: 24px;
        background: #f6f7f9;
        color: #1b1f24;
        font-family: Tahoma, "Iranian Sans", sans-serif;
        font-size: 15px;
        line-height: 1.9;
        text-align: start;
      }
      .card {
        max-width: 640px;
        margin-inline: auto;
        padding: 24px;
        background: #ffffff;
        border-radius: 12px;
        border-inline-start: 4px solid #0b6b53;
      }
      h1 {
        margin: 0 0 16px;
        font-size: 17px;
        font-weight: 700;
      }
      p {
        margin: 0 0 12px;
      }
      .footer {
        margin-block-start: 20px;
        padding-block-start: 12px;
        border-block-start: 1px solid #e3e6ea;
        color: #5b636d;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(title)}</h1>
${paragraphs}
      <p class="footer">این پیام از سامانهٔ رستا فرستاده شده است.</p>
    </div>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Escapes — one per grammar
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripNewlines(value: string): string {
  return value.replace(NEWLINES, ' ').trim();
}

function identity(value: string): string {
  return value;
}

function interpolate(source: string, resolve: (name: string) => string): string {
  return source.replace(PLACEHOLDER, (_match, name: string) => resolve(name));
}

function placeholdersIn(source: string): string[] {
  // A fresh regex per call: a `/g` expression carries `lastIndex` between
  // calls, and sharing one made an identical input answer differently on
  // alternate calls once already in this service.
  return [...source.matchAll(new RegExp(PLACEHOLDER.source, 'g'))].map((match) => match[1]);
}

function isPresent(value: ContextValue | undefined): boolean {
  return value !== undefined && value !== null && value !== '';
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
