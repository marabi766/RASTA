#!/usr/bin/env node
// -----------------------------------------------------------------------------
// The one boundary between a database URL and psql's command line (FU-128, FU-104).
// A process's argv is readable by every local user while it runs, so a URL gets to
// psql only through `libpqInvocation` or `psqlInvocation` below: the password leaves
// for the environment, and a URL they cannot prove free of credentials is refused.
//
// As a command, for runbooks:
//
//   node scripts/psql-prisma-url.mjs DATABASE_URL_MARKETPLACE_MIGRATOR -X -f file.sql
//
// psql refuses a Prisma URL (`invalid URI query parameter: "schema"`), and cutting the
// query off leaves the schema behind: the same statement then runs on whatever
// another schema holds. The command takes the NAME of the variable, so that the URL
// and its password stay off this process's argv too. Everything after the name goes
// to psql; psql's exit code is this one's. The schema travels in `PGOPTIONS`, so the
// connection must reach PostgreSQL directly: PgBouncer discards it (FU-144).
// -----------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UnreadableUrlError, readUrl } from '../packages/config/src/url-reader.js';

/**
 * What every libpq helper below refuses a URL that does not parse with: a fixed
 * text. `new URL`'s own error keeps the whole input on `.input`, which an
 * uncaught throw prints — the password included, since these run before it is
 * taken out (#385 r5).
 */
export const UNREADABLE_DATABASE_URL =
  'the database URL cannot be read as a URL, so it is not handed to psql; its value is not repeated';

/** What they refuse a parameter with that may carry a credential: a fixed text, as the URL is secret. */
export const UNSAFE_DATABASE_PARAMETER =
  'the database URL has a parameter that cannot be kept off the command line, or more than one password, so it is not handed to psql; its value is not repeated';

/** What {@link psqlInvocation} refuses a schema with: a fixed text, as the URL is secret. */
export const UNUSABLE_PRISMA_SCHEMA =
  'the schema parameter of the database URL is not one plain lowercase identifier, so psql cannot be pointed at it; its value is not repeated';

/** What it refuses a URL with that could still override `PGOPTIONS` or the schema. */
export const UNUSABLE_PRISMA_OPTIONS =
  'the database URL names a service or repeats options, so what psql is told could be overridden; its value is not repeated';

/**
 * The only URL shape whose credentials `new URL` and libpq find in the same place. A password with a raw
 * `#`, `?` or `/` ends the authority for `new URL` and not for libpq: with digits before
 * it (`u:123#s3cret@db/app`) it even parses, as host `u` and port 123, with the secret
 * left in the fragment, query or path. So: one `@` at most and before any `/`, `?` or
 * `#`; no `#` at all; a plain host and database name, not even percent-encoded and with
 * no dot segment for `new URL` to resolve away; no whitespace, control character or
 * backslash, which it may drop or rewrite.
 */
const UNAMBIGUOUS_DATABASE_URL =
  /^postgres(?:ql)?:\/\/(?:[^/?#@\\\s\p{Cc}]*@)?(?:[\w.-]*|\[[0-9A-Fa-f:.]+\])(?::\d+)?(?:\/[\w$-]*)?(?:\?[^?#@\\\s\p{Cc}]*)?$/u;

/**
 * Query parameters only Prisma understands: dropped, as psql would refuse them.
 */
const PRISMA_ONLY_PARAMETERS = [
  'schema',
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
];

/**
 * libpq's parameters that hold no credential: kept, so psql connects as configured.
 * An allowlist, as anything else may be one: `sslpassword` (libpq has no environment
 * variable for it, so it cannot leave the URL), `oauth_client_secret`, `dbname` (it
 * can hold a whole connection string), and whatever a later libpq adds.
 */
const PLAIN_LIBPQ_PARAMETERS = [
  'application_name',
  'channel_binding',
  'client_encoding',
  'connect_timeout',
  'fallback_application_name',
  'gssencmode',
  'host',
  'hostaddr',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'krbsrvname',
  'load_balance_hosts',
  'options',
  'port',
  'require_auth',
  'requirepeer',
  'service',
  'ssl_max_protocol_version',
  'ssl_min_protocol_version',
  'sslcert',
  'sslcompression',
  'sslcrl',
  'sslcrldir',
  'sslkey',
  'sslmode',
  'sslnegotiation',
  'sslrootcert',
  'sslsni',
  'target_session_attrs',
  'tcp_user_timeout',
  'user',
];

/** A kept value, decoded: `u:123?sslmode=s3cret%40db%2Fapp` must not pass on an allowed name. */
const PLAIN_PARAMETER_VALUE = /^[\w.,:/~= -]*$/;

/** In a decoded password: cannot reach the environment (NUL), or was never valid UTF-8. */
const UNUSABLE_PASSWORD_CHARACTER = /[\p{Cc}\uFFFD]/u;

/** A whole `user:password` encoded into the username, or a control character. */
const UNUSABLE_USERNAME_CHARACTER = /[:\p{Cc}]/u;

/** In a query with a password: `new URL` reads `+` as a space and keeps `%ZZ`; libpq does neither. */
const AMBIGUOUS_QUERY_ESCAPE = /\+|%(?![0-9A-Fa-f]{2})/;

/**
 * `target` with `params` as its query, each name and value percent-encoded.
 *
 * Not `URLSearchParams`: it writes a space as `+`, which libpq's URI parser
 * does not decode — `options=-c TimeZone=UTC` (L7-37) would reach the server
 * as `-c+TimeZone=UTC` and the connection be refused. Prisma reads either.
 */
function withLibpqQuery(target, params) {
  const query = params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  target.search = '';
  return query ? `${target.toString()}?${query}` : target.toString();
}

/** A part of the userinfo, decoded; a broken escape is refused. */
function decodedUserinfo(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    throw new UnreadableUrlError(UNREADABLE_DATABASE_URL);
  }
}

/**
 * How to hand `url` to psql without any credential on the command line, where any
 * local user can read it (`ps`, `/proc/<pid>/cmdline`) for as long as the process
 * runs (D-045 follow-up). `target` is the libpq URL with the password removed — from
 * the userinfo or from a `password=` parameter — and `env` carries it as `PGPASSWORD`,
 * which libpq reads when the URL has none. Spread `env` over the child's environment;
 * it is empty when the URL has no password, so an inherited `PGPASSWORD` or `.pgpass`
 * still applies. Whatever cannot be proven free of a credential is refused, with a
 * fixed text.
 */
export function libpqInvocation(url) {
  if (typeof url !== 'string' || !UNAMBIGUOUS_DATABASE_URL.test(url)) {
    throw new UnreadableUrlError(UNREADABLE_DATABASE_URL);
  }
  const target = readUrl(url, { refusal: UNREADABLE_DATABASE_URL });
  const params = [...target.searchParams];
  const passwords = target.password ? [decodedUserinfo(target.password)] : [];
  if (UNUSABLE_USERNAME_CHARACTER.test(decodedUserinfo(target.username))) {
    throw new UnreadableUrlError(UNSAFE_DATABASE_PARAMETER);
  }
  const kept = [];
  for (const [name, value] of params) {
    if (name === 'password') {
      passwords.push(value);
    } else if (
      PLAIN_LIBPQ_PARAMETERS.includes(name) &&
      PLAIN_PARAMETER_VALUE.test(value) &&
      !(name === 'user' && UNUSABLE_USERNAME_CHARACTER.test(value))
    ) {
      kept.push([name, value]);
    } else if (!PRISMA_ONLY_PARAMETERS.includes(name)) {
      throw new UnreadableUrlError(UNSAFE_DATABASE_PARAMETER);
    }
  }
  // Each reader takes a different one of several, or reads this one differently.
  if (
    passwords.length > 1 ||
    passwords.some((given) => UNUSABLE_PASSWORD_CHARACTER.test(given)) ||
    (params.some(([name]) => name === 'password') && AMBIGUOUS_QUERY_ESCAPE.test(target.search))
  ) {
    throw new UnreadableUrlError(UNSAFE_DATABASE_PARAMETER);
  }
  target.password = '';
  return {
    target: withLibpqQuery(target, kept),
    env: passwords[0] ? { PGPASSWORD: passwords[0] } : {},
  };
}

/**
 * {@link libpqInvocation} that also lands where Prisma would (FU-128): `?schema=`,
 * `public` when absent as for Prisma, becomes `search_path`.
 *
 * All through `PGOPTIONS`, never the URL's `options`: libpq lets that override
 * `PGOPTIONS`, which would silently drop what the operator set there, such as
 * `default_transaction_read_only=on`. So the URL's own `options` move over, the
 * operator's come after them and win, and the schema comes last: the URL decides it.
 * A service file's `options` would override `PGOPTIONS` too, so `service` is refused.
 */
export function psqlInvocation(url, inheritedOptions) {
  const { target, env } = libpqInvocation(url);
  const schemas = readUrl(url, { refusal: UNREADABLE_DATABASE_URL }).searchParams.getAll('schema');
  const schema = schemas.length === 0 ? 'public' : schemas[0];
  if (schemas.length > 1 || !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(UNUSABLE_PRISMA_SCHEMA);
  }
  const parsed = readUrl(target, { refusal: UNREADABLE_DATABASE_URL });
  const urlOptions = parsed.searchParams.getAll('options');
  if (parsed.searchParams.has('service') || urlOptions.length > 1) {
    throw new Error(UNUSABLE_PRISMA_OPTIONS);
  }
  const kept = [...parsed.searchParams].filter(([name]) => name !== 'options');
  const options = [...urlOptions, inheritedOptions, `-c search_path=${schema}`].filter(Boolean);
  return {
    target: withLibpqQuery(parsed, kept),
    env: { ...env, PGOPTIONS: options.join(' ') },
  };
}

function main() {
  const [name, ...args] = process.argv.slice(2);
  if (!/^DATABASE_URL_[A-Z0-9_]+$/.test(name ?? '') || !process.env[name]) {
    console.error('the first argument must name a set DATABASE_URL_* variable, never hold a URL');
    return 2;
  }

  // A service file's `options` would override PGOPTIONS, with no error.
  if (process.env.PGSERVICE) {
    console.error(UNUSABLE_PRISMA_OPTIONS);
    return 2;
  }

  let invocation;
  try {
    invocation = psqlInvocation(process.env[name], process.env.PGOPTIONS);
  } catch (error) {
    // Only a fixed text: anything else may quote the URL.
    const fixed = [UNSAFE_DATABASE_PARAMETER, UNUSABLE_PRISMA_SCHEMA, UNUSABLE_PRISMA_OPTIONS];
    console.error(fixed.includes(error.message) ? error.message : UNREADABLE_DATABASE_URL);
    return 2;
  }

  const result = spawnSync('psql', [invocation.target, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...invocation.env },
  });
  if (result.error) console.error('psql could not be started');
  return result.status ?? 1;
}

/** Both real paths: through a symlink they differ, and a runbook's command would do nothing and exit 0. */
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false; // `node -e` has no script: argv[1] is absent, or the first argument.
  }
}

if (isEntryPoint()) process.exit(main());
