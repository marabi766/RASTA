/**
 * No service process is ever given a Kafka credential that is not its own
 * (RUN-006, review of #131 finding 1). The admin's password makes a client
 * the broker's super user and bypasses every ACL; ops-replay's reads every
 * dead-letter topic; the test observer's reads everything. None of them may
 * reach a service:
 *
 *   - `.env.example`, which every service's dev script loads whole, assigns
 *     only services' own passwords (a shared development .env holding each
 *     service's password is the accepted development-only residual);
 *   - `infrastructure/docker/kafka/bootstrap.env.example` holds exactly the
 *     bootstrap-only credentials, and compose gives that file to the broker
 *     and kafka-init alone;
 *   - a developer's own `.env` does not hold one either (`pnpm infra:up`
 *     refuses it through the infra preflight);
 *   - CI never exports a Kafka password to later steps ($GITHUB_ENV) or in an
 *     `env:` block; each step takes a scope from `kafka-credentials.sh`, a
 *     service start step only `service <that service>`, and the `admin` scope
 *     is the broker tests' alone;
 *   - the per-run secrets directories are no secret's backdoor (review of #131,
 *     round 2): neither reaches $GITHUB_ENV or a job- or workflow-level `env:`;
 *     `KAFKA_SECRETS_DIR` goes, in a step's own `env:`, only to a step that
 *     calls kafka-credentials.sh or ci-up.sh, and a step that starts services
 *     unsets it before it launches any; `KAFKA_ADMIN_SECRETS_DIR` goes only to
 *     the broker bootstrap and the broker tests.
 *
 * The accepted CI residual (ADR-061 § 3): every step runs as the same runner
 * user, so test code pointed at a secrets directory can read what is in it.
 *
 * Pure: file texts in, problems out. Text rather than a YAML parse, as the
 * repository's other static checks do.
 */

export const BOOTSTRAP_ONLY = ['ADMIN', 'OPS_REPLAY', 'ITEST_OBSERVER'];
export const TOOLS = ['KAFKA_UI', 'KAFKA_EXPORTER'];
const PASSWORD = /KAFKA_SASL_PASSWORD_([A-Z0-9_]+)/;
export const ADMIN_SCOPE_STEP = 'Broker authorisation, asked of the broker';
export const BOOTSTRAP_STEP = 'Start the authenticated Kafka broker';
const SECRETS_DIRS = ['KAFKA_SECRETS_DIR', 'KAFKA_ADMIN_SECRETS_DIR'];

/** `fleet-service` -> `FLEET`: the stem of a service's password variable. */
export function serviceStem(service) {
  return service
    .replace(/-service$/, '')
    .replace(/-/g, '_')
    .toUpperCase();
}

const uncommented = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');

/** Problems in `.env.example`: any Kafka password it assigns that is not a service's own. */
export function checkEnvExample(text, services) {
  const allowed = new Set(services.map(serviceStem));
  const problems = [];
  for (const line of text.split('\n')) {
    const match = /^\s*KAFKA_SASL_PASSWORD_([A-Z0-9_]+)\s*=/.exec(line);
    if (match && !allowed.has(match[1])) {
      problems.push(
        `.env.example assigns KAFKA_SASL_PASSWORD_${match[1]}, which is not a service's own`,
      );
    }
  }
  return problems;
}

/**
 * Problems in a developer's own `.env`, which every service's dev script
 * loads whole: it may not assign a bootstrap-only credential (those belong in
 * infrastructure/docker/kafka/bootstrap.env).
 */
export function checkLocalEnv(text) {
  const problems = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?KAFKA_SASL_PASSWORD_([A-Z0-9_]+)\s*=/.exec(line);
    if (match && BOOTSTRAP_ONLY.includes(match[1])) {
      problems.push(
        `.env assigns KAFKA_SASL_PASSWORD_${match[1]}, which every service would load; ` +
          'move it to infrastructure/docker/kafka/bootstrap.env',
      );
    }
  }
  return problems;
}

/** Problems in the bootstrap example: it must hold exactly the bootstrap-only credentials. */
export function checkBootstrapExample(text) {
  const assigned = [...text.matchAll(/^\s*KAFKA_SASL_PASSWORD_([A-Z0-9_]+)\s*=/gm)].map(
    (m) => m[1],
  );
  return JSON.stringify([...assigned].sort()) === JSON.stringify([...BOOTSTRAP_ONLY].sort())
    ? []
    : [
        `bootstrap.env.example must assign exactly ${BOOTSTRAP_ONLY.join(', ')}; it assigns ${assigned.join(', ') || 'nothing'}`,
      ];
}

/** The workflow's steps, as `{ name, text }`, split on `- name:` at step indentation. */
export function workflowSteps(text) {
  const steps = [];
  const pattern = /^ {6}- name: (.+)$/gm;
  const starts = [...text.matchAll(pattern)];
  starts.forEach((match, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].index : text.length;
    steps.push({ name: match[1].trim(), text: text.slice(match.index, end) });
  });
  return steps;
}

/** Problems in ci.yml. */
export function checkWorkflow(text) {
  const problems = [];
  const code = uncommented(text);
  for (const line of code.split('\n')) {
    if (/^\s+KAFKA_SASL_PASSWORD_[A-Z0-9_]+\s*:/.test(line)) {
      problems.push(
        `ci.yml sets ${line.trim()} in an env block; take a kafka-credentials.sh scope instead`,
      );
    }
    if (line.includes('GITHUB_ENV') && PASSWORD.test(line)) {
      problems.push(`ci.yml exports a Kafka password to later steps: ${line.trim()}`);
    }
    for (const dir of SECRETS_DIRS) {
      if (!line.includes(dir)) continue;
      if (line.includes('GITHUB_ENV')) {
        problems.push(`ci.yml exports ${dir} to later steps: ${line.trim()}`);
      }
      const key = new RegExp(`^(\\s*)${dir}\\s*:`).exec(line);
      // A step's own env keys sit at ten spaces; a job's at six, the workflow's at two.
      if (key && key[1].length !== 10) {
        problems.push(
          `ci.yml sets ${dir} in a job- or workflow-level env; give it to the steps that need it`,
        );
      }
    }
  }
  for (const step of workflowSteps(code)) {
    if (/kafka-credentials\.sh admin\b/.test(step.text) && step.name !== ADMIN_SCOPE_STEP) {
      problems.push(`"${step.name}" takes the admin scope, which only "${ADMIN_SCOPE_STEP}" may`);
    }
    if (
      step.text.includes('KAFKA_ADMIN_SECRETS_DIR') &&
      ![ADMIN_SCOPE_STEP, BOOTSTRAP_STEP].includes(step.name)
    ) {
      problems.push(
        `"${step.name}" is given KAFKA_ADMIN_SECRETS_DIR, which only "${BOOTSTRAP_STEP}" and "${ADMIN_SCOPE_STEP}" may be`,
      );
    }
    if (
      /^\s+KAFKA_SECRETS_DIR\s*:/m.test(step.text) &&
      !/kafka-credentials\.sh|kafka\/ci-up\.sh/.test(step.text)
    ) {
      problems.push(
        `"${step.name}" is given KAFKA_SECRETS_DIR but calls neither kafka-credentials.sh nor ci-up.sh`,
      );
    }
    if (!step.text.includes('dist/main.js')) continue;
    // A step that starts services: the directory leaves the environment
    // before the first process is launched, so none inherits it.
    const run = step.text.slice(Math.max(0, step.text.indexOf('run:')));
    const unset = run.indexOf('unset KAFKA_SECRETS_DIR');
    const firstLaunch = Math.min(
      ...['cd services/', 'dist/main.js']
        .map((marker) => run.indexOf(marker))
        .filter((i) => i >= 0),
    );
    if (step.text.includes('KAFKA_SECRETS_DIR') && (unset < 0 || unset > firstLaunch)) {
      problems.push(`"${step.name}" starts services without first unsetting KAFKA_SECRETS_DIR`);
    }
    // A step that starts services: each service with its own password only.
    if (/kafka-credentials\.sh (tests|admin|observer)\b/.test(step.text)) {
      problems.push(`"${step.name}" starts services with a scope wider than one service's own`);
    }
    for (const name of [...BOOTSTRAP_ONLY, ...TOOLS]) {
      if (step.text.includes(`KAFKA_SASL_PASSWORD_${name}`)) {
        problems.push(`"${step.name}" starts services and names KAFKA_SASL_PASSWORD_${name}`);
      }
    }
    const lines = step.text.split('\n');
    lines.forEach((line, index) => {
      const cd = /cd services\/([a-z-]+-service)\b/.exec(line);
      if (!cd) return;
      const before = lines.slice(Math.max(0, index - 3), index).join('\n');
      const scope = /kafka-credentials\.sh service ([a-z-]+)/.exec(before);
      if (!scope || scope[1] !== cd[1]) {
        problems.push(`"${step.name}" starts ${cd[1]} without exactly its own credential scope`);
      }
    });
  }
  return problems;
}

/** Problems in ci-up.sh: it may publish only what is not secret. */
export function checkCiUp(text) {
  const problems = [];
  const code = uncommented(text);
  for (const line of code.split('\n')) {
    if (
      /^\s*publish\s/.test(line) &&
      (PASSWORD.test(line) || line.includes('${variable}') || /SECRETS_DIR/.test(line))
    ) {
      problems.push(`ci-up.sh publishes a credential to later steps: ${line.trim()}`);
    }
  }
  const writes = code
    .split('\n')
    .filter((line) => /GITHUB_ENV["}]*\s*$/.test(line) && line.includes('>>'));
  if (writes.length !== 1 || !/echo "\$1=\$2"/.test(writes[0])) {
    problems.push('ci-up.sh writes to $GITHUB_ENV outside publish()');
  }
  return problems;
}

/** The services under `services:` in docker-compose.yml, as `{ name, text }`. */
export function composeServices(text) {
  const header = '\nservices:\n';
  const start = text.indexOf(header);
  if (start < 0) return [];
  const rest = text.slice(start + header.length);
  const next = /^[^\s#]/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  const starts = [...section.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    text: section.slice(
      match.index,
      index + 1 < starts.length ? starts[index + 1].index : section.length,
    ),
  }));
}

/** Problems in docker-compose.yml. */
export function checkCompose(text) {
  const problems = [];
  const code = uncommented(text);
  for (const name of BOOTSTRAP_ONLY) {
    if (code.includes(`KAFKA_SASL_PASSWORD_${name}`)) {
      problems.push(
        `docker-compose.yml names KAFKA_SASL_PASSWORD_${name}; it belongs in bootstrap.env only`,
      );
    }
  }
  const readers = composeServices(code)
    .filter((service) => service.text.includes('*kafka-bootstrap-env'))
    .map((service) => service.name)
    .sort();
  if (JSON.stringify(readers) !== JSON.stringify(['kafka', 'kafka-init'])) {
    problems.push(
      `the bootstrap env file must go to kafka and kafka-init only, not ${readers.join(', ')}`,
    );
  }
  return problems;
}
