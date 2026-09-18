/**
 * The committed local PostgreSQL defaults must name the IPv4 loopback literal.
 *
 * ## Why
 *
 * `docker compose` and ad hoc TCP forwarders often publish PostgreSQL on IPv4
 * only, while `localhost` can resolve to `::1` first. On the host where this was
 * diagnosed (2026-09-14), every lazily opened Prisma pool connection then paid
 * about two seconds before falling back to IPv4. That is longer than Prisma's
 * default interactive-transaction `maxWait`, so concurrent transactional tests
 * failed with `P2028` — which looks like application lock contention and is
 * not. `127.0.0.1` removes the ambiguity. This is a local developer default,
 * not a production networking policy.
 *
 * ## What is checked
 *
 * `.env.example` is read as text and never executed. `POSTGRES_HOST` must be
 * exactly `127.0.0.1`; every `DATABASE_URL_*` with a PostgreSQL scheme —
 * runtime and migrator alike — must use that host and the declared
 * `POSTGRES_PORT`. A relevant assignment that is malformed or declared twice
 * fails closed, because a dotenv loader silently picks one of the two.
 *
 * ## What is never printed
 *
 * A URL carries credentials, so no message contains a value. A failure names
 * the variable, its line and a fixed category for the host (`localhost`,
 * `IPv6 literal`, `other host`) or the port number.
 */

/** The only host the committed local PostgreSQL defaults may name. */
export const REQUIRED_HOST = '127.0.0.1';

/** Variables this contract owns. */
const HOST_VARIABLE = 'POSTGRES_HOST';
const PORT_VARIABLE = 'POSTGRES_PORT';
const URL_PREFIX = 'DATABASE_URL_';

const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const POSTGRES_SCHEMES = new Set(['postgresql:', 'postgres:']);

/** True for a name this contract validates. */
export function isRelevantName(name) {
  return name === HOST_VARIABLE || name === PORT_VARIABLE || name.startsWith(URL_PREFIX);
}

/** A value as a dotenv loader reads it: trimmed, with one pair of matching quotes removed. */
export function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.at(-1) === first) return value.slice(1, -1);
  }
  return value;
}

/**
 * Every assignment in dotenv text, in order, with its 1-based line.
 *
 * Blank lines and `#` comments are skipped. A line that is neither is returned
 * in `malformed` — with the name it seems to carry, if any — so the caller can
 * fail closed when that name is one it owns.
 */
export function parseEnvAssignments(text) {
  const assignments = [];
  const malformed = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return;
    const match = ASSIGNMENT.exec(line);
    if (!match) {
      const guessed = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      malformed.push({ line: index + 1, name: guessed ? guessed[1] : null });
      return;
    }
    assignments.push({ name: match[1], value: unquote(match[2]), line: index + 1 });
  });
  return { assignments, malformed };
}

/** A fixed, value-free description of a host. */
export function classifyHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === REQUIRED_HOST) return REQUIRED_HOST;
  if (host === 'localhost') return 'localhost';
  if (host.startsWith('[')) return 'IPv6 literal';
  if (host === '') return 'empty host';
  return 'other host';
}

/**
 * The URL's scheme, or null when the value has no `scheme://` prefix. Never
 * throws. `user:password@host` is not a scheme, so it must not be ignored as a
 * non-PostgreSQL URL.
 */
function schemeOf(value) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  return match ? `${match[1].toLowerCase()}:` : null;
}

/**
 * Validates dotenv text against the local PostgreSQL contract.
 *
 * Returns `{ errors, postgresUrls, ignoredUrls }`: `errors` are safe to print,
 * `postgresUrls` and `ignoredUrls` are variable names only.
 */
export function validateLocalPostgresConfig(text) {
  const errors = [];
  const { assignments, malformed } = parseEnvAssignments(text);

  for (const entry of malformed) {
    if (entry.name !== null && isRelevantName(entry.name)) {
      errors.push(`${entry.name} (line ${entry.line}): malformed assignment`);
    }
  }

  const byName = new Map();
  for (const assignment of assignments) {
    if (!isRelevantName(assignment.name)) continue;
    const seen = byName.get(assignment.name);
    if (seen) {
      errors.push(
        `${assignment.name} (line ${assignment.line}): duplicate assignment (first on line ${seen.line})`,
      );
      continue;
    }
    byName.set(assignment.name, assignment);
  }

  const host = byName.get(HOST_VARIABLE);
  if (!host) {
    errors.push(`${HOST_VARIABLE}: missing`);
  } else if (host.value !== REQUIRED_HOST) {
    errors.push(
      `${HOST_VARIABLE} (line ${host.line}): must be ${REQUIRED_HOST} (found ${classifyHost(host.value)})`,
    );
  }

  const portAssignment = byName.get(PORT_VARIABLE);
  let port = null;
  if (!portAssignment) {
    errors.push(`${PORT_VARIABLE}: missing`);
  } else if (
    !/^\d{1,5}$/.test(portAssignment.value) ||
    Number(portAssignment.value) < 1 ||
    Number(portAssignment.value) > 65535
  ) {
    errors.push(`${PORT_VARIABLE} (line ${portAssignment.line}): must be a port number 1-65535`);
  } else {
    port = String(Number(portAssignment.value));
  }

  const postgresUrls = [];
  const ignoredUrls = [];
  for (const assignment of byName.values()) {
    if (!assignment.name.startsWith(URL_PREFIX)) continue;
    const where = `${assignment.name} (line ${assignment.line})`;
    const scheme = schemeOf(assignment.value);

    if (scheme === null) {
      // Without a scheme nothing proves this is not a PostgreSQL URL.
      errors.push(`${where}: malformed URL (no scheme)`);
      continue;
    }
    if (!scheme.startsWith('postgres')) {
      ignoredUrls.push(assignment.name);
      continue;
    }
    if (!POSTGRES_SCHEMES.has(scheme)) {
      errors.push(`${where}: malformed PostgreSQL URL (unsupported scheme)`);
      continue;
    }

    postgresUrls.push(assignment.name);
    let url;
    try {
      url = new URL(assignment.value);
    } catch {
      errors.push(`${where}: malformed PostgreSQL URL`);
      continue;
    }
    if (url.hostname === '') {
      errors.push(`${where}: malformed PostgreSQL URL (no host)`);
      continue;
    }
    if (url.hostname !== REQUIRED_HOST) {
      errors.push(`${where}: host must be ${REQUIRED_HOST} (found ${classifyHost(url.hostname)})`);
    }
    if (url.port === '') {
      errors.push(`${where}: port must be stated and equal ${PORT_VARIABLE}`);
    } else if (port !== null && url.port !== port) {
      errors.push(`${where}: port ${url.port} does not equal ${PORT_VARIABLE} ${port}`);
    }
  }

  if (postgresUrls.length === 0) {
    errors.push(`${URL_PREFIX}*: no PostgreSQL URL declared`);
  }

  return { errors, postgresUrls, ignoredUrls };
}
