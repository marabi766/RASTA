// @ts-check
'use strict';
// -----------------------------------------------------------------------------
// The one place a URL from configuration (the environment, argv, a file an
// operator wrote) is parsed (#385 r5).
//
// `new URL(value)` refuses with a TypeError that keeps the whole input on
// `.input` (and the base on `.base`), and Node prints both for an uncaught
// throw — a database URL's password included. `readUrl` refuses instead with a
// fresh error carrying a fixed text only: no `cause`, no `.input`, nothing of
// the native error and nothing of the value.
//
// Plain CommonJS, so it runs before any build: the scripts import this file
// itself (migrations run straight after `pnpm install`, before any package's
// dist exists — scripts/prisma-lib.mjs), and TypeScript consumers import it
// through `@rasta/config`, whose build compiles it into dist like the rest.
// `scripts/url-parsing-guard.test.mjs` fails on any other `new URL(…)`,
// `URL.parse(…)`, `URL.canParse(…)` or `url.parse(…)` of a value that is not
// a literal, in scripts/, packages/, services/, apps/ and tests/.
// -----------------------------------------------------------------------------

/** What an unreadable URL is refused with unless the caller names a fixed text. */
const UNREADABLE_URL = 'a configured URL cannot be read as a URL (its value is not repeated)';

/** The refusal {@link readUrl} throws: a fixed text, never the value. */
class UnreadableUrlError extends Error {
  /** @param {string} [text] a fixed text; never anything read from configuration */
  constructor(text = UNREADABLE_URL) {
    super(text);
    this.name = 'UnreadableUrlError';
  }
}

/**
 * `value` parsed as a URL (against `base`, when given), or null when it is not
 * one — or is not a string at all. Nothing of the failure is kept.
 *
 * @param {unknown} value
 * @param {string | URL} [base]
 * @returns {URL | null}
 */
function tryReadUrl(value, base) {
  if (typeof value !== 'string') return null;
  if (base !== undefined && typeof base !== 'string' && !(base instanceof URL)) return null;
  try {
    return base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
}

/**
 * `value` parsed as a URL (against `base`, when given). Throws a fresh
 * {@link UnreadableUrlError} with `refusal` — a fixed text naming the setting,
 * never its value — when it is not one.
 *
 * @param {unknown} value
 * @param {{ base?: string | URL, refusal?: string }} [options]
 * @returns {URL}
 */
function readUrl(value, options = {}) {
  const parsed = tryReadUrl(value, options.base);
  // Thrown here, outside tryReadUrl's catch, so nothing of the native error
  // travels with it.
  if (parsed === null) throw new UnreadableUrlError(options.refusal);
  return parsed;
}

exports.UNREADABLE_URL = UNREADABLE_URL;
exports.UnreadableUrlError = UnreadableUrlError;
exports.tryReadUrl = tryReadUrl;
exports.readUrl = readUrl;
