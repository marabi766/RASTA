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
 *   - CI never exports a Kafka password to later steps ($GITHUB_ENV) or in an
 *     `env:` block; each step takes a scope from `kafka-credentials.sh`, a
 *     service start step only `service <that service>`, and the `admin` scope
 *     is the broker tests' alone.
 *
 * Pure: file texts in, problems out. Text rather than a YAML parse, as the
 * repository's other static checks do.
 */

export const BOOTSTRAP_ONLY = ['ADMIN', 'OPS_REPLAY', 'ITEST_OBSERVER'];
export const TOOLS = ['KAFKA_UI', 'KAFKA_EXPORTER'];
const PASSWORD = /KAFKA_SASL_PASSWORD_([A-Z0-9_]+)/;
export const ADMIN_SCOPE_STEP = 'Broker authorisation, asked of the broker';

/** `fleet-service` -> `FLEET`: the stem of a service's password variable. */
export function serviceStem(service) {
  return service.replace(/-service$/, '').replace(/-/g, '_').toUpperCase();
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
      problems.push(`.env.example assigns KAFKA_SASL_PASSWORD_${match[1]}, which is not a service's own`);
    }
  }
  return problems;
}

/** Problems in the bootstrap example: it must hold exactly the bootstrap-only credentials. */
export function checkBootstrapExample(text) {
  const assigned = [...text.matchAll(/^\s*KAFKA_SASL_PASSWORD_([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
  return JSON.stringify([...assigned].sort()) === JSON.stringify([...BOOTSTRAP_ONLY].sort())
    ? []
    : [`bootstrap.env.example must assign exactly ${BOOTSTRAP_ONLY.join(', ')}; it assigns ${assigned.join(', ') || 'nothing'}`];
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
      problems.push(`ci.yml sets ${line.trim()} in an env block; take a kafka-credentials.sh scope instead`);
    }
    if (line.includes('GITHUB_ENV') && PASSWORD.test(line)) {
      problems.push(`ci.yml exports a Kafka password to later steps: ${line.trim()}`);
    }
  }
  for (const step of workflowSteps(code)) {
    if (/kafka-credentials\.sh admin\b/.test(step.text) && step.name !== ADMIN_SCOPE_STEP) {
      problems.push(`"${step.name}" takes the admin scope, which only "${ADMIN_SCOPE_STEP}" may`);
    }
    if (!step.text.includes('dist/main.js')) continue;
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
    if (/^\s*publish\s/.test(line) && (PASSWORD.test(line) || line.includes('${variable}'))) {
      problems.push(`ci-up.sh publishes a credential to later steps: ${line.trim()}`);
    }
  }
  const writes = code.split('\n').filter((line) => /GITHUB_ENV["}]*\s*$/.test(line) && line.includes('>>'));
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
    text: section.slice(match.index, index + 1 < starts.length ? starts[index + 1].index : section.length),
  }));
}

/** Problems in docker-compose.yml. */
export function checkCompose(text) {
  const problems = [];
  const code = uncommented(text);
  for (const name of BOOTSTRAP_ONLY) {
    if (code.includes(`KAFKA_SASL_PASSWORD_${name}`)) {
      problems.push(`docker-compose.yml names KAFKA_SASL_PASSWORD_${name}; it belongs in bootstrap.env only`);
    }
  }
  const readers = composeServices(code)
    .filter((service) => service.text.includes('*kafka-bootstrap-env'))
    .map((service) => service.name)
    .sort();
  if (JSON.stringify(readers) !== JSON.stringify(['kafka', 'kafka-init'])) {
    problems.push(`the bootstrap env file must go to kafka and kafka-init only, not ${readers.join(', ')}`);
  }
  return problems;
}
