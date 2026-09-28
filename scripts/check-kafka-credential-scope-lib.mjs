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
 * Pure: file texts in, problems out. The workflow is read as YAML (review of
 * #131, verify pass) — workflow `env`, every job's `env` (and its service
 * containers' and container's), and every step, named or not, with its `env`
 * and `run` — so neither flow-style mappings nor an unnamed step slip past;
 * the other files are line-oriented and read as text.
 */
import { parse as parseYaml } from 'yaml';

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
 * loads whole: like `.env.example`, it may assign no Kafka credential but a
 * service's own — not a bootstrap-only one (admin, ops-replay, the observer:
 * infrastructure/docker/kafka/bootstrap.env) and not a tool's (Kafka UI, the
 * exporter: compose's own defaults), with which a service could authenticate
 * as that principal (review of #131, verify pass).
 */
export function checkLocalEnv(text, services) {
  const allowed = new Set(services.map(serviceStem));
  const problems = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?KAFKA_SASL_PASSWORD_([A-Z0-9_]+)\s*=/.exec(line);
    if (match && !allowed.has(match[1])) {
      problems.push(
        `.env assigns KAFKA_SASL_PASSWORD_${match[1]}, which is not a service's own and which every ` +
          'service would load; bootstrap-only credentials belong in infrastructure/docker/kafka/bootstrap.env',
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

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value) => (isMapping(value) ? Object.keys(value) : []);

/**
 * The workflow's steps, named or not, as `{ job, name, env, run }`. A step
 * without a name is labelled by its job and position, and by `uses` if it has one.
 */
export function workflowSteps(text) {
  const workflow = parseYaml(text) ?? {};
  const steps = [];
  for (const [job, definition] of Object.entries(isMapping(workflow.jobs) ? workflow.jobs : {})) {
    const list = Array.isArray(definition?.steps) ? definition.steps : [];
    list.forEach((step, index) => {
      if (!isMapping(step)) return;
      const name =
        typeof step.name === 'string'
          ? step.name
          : `${job} step ${index + 1}${step.uses ? ` (${step.uses})` : ''}`;
      steps.push({
        job,
        name,
        env: isMapping(step.env) ? step.env : {},
        run: typeof step.run === 'string' ? step.run : '',
      });
    });
  }
  return steps;
}

/** Every `env` above step level: the workflow's, each job's, and each job's containers'. */
function envAboveSteps(workflow) {
  const scopes = [{ where: 'the workflow-level env', env: workflow.env }];
  for (const [job, definition] of Object.entries(isMapping(workflow.jobs) ? workflow.jobs : {})) {
    if (!isMapping(definition)) continue;
    scopes.push({ where: `job "${job}"'s env`, env: definition.env });
    if (isMapping(definition.container)) {
      scopes.push({ where: `job "${job}"'s container env`, env: definition.container.env });
    }
    for (const [service, container] of Object.entries(
      isMapping(definition.services) ? definition.services : {},
    )) {
      scopes.push({ where: `job "${job}"'s service "${service}" env`, env: container?.env });
    }
  }
  return scopes;
}

/** Problems in ci.yml. */
export function checkWorkflow(text) {
  const problems = [];
  let workflow;
  try {
    workflow = parseYaml(text) ?? {};
  } catch (error) {
    return [`ci.yml is not valid YAML: ${error.message}`];
  }
  // No Kafka password and no secrets directory above step level: those reach
  // every step of the job, service starts included.
  for (const { where, env } of envAboveSteps(workflow)) {
    for (const key of keysOf(env)) {
      if (PASSWORD.test(key) || SECRETS_DIRS.includes(key)) {
        problems.push(`ci.yml sets ${key} in ${where}; give it to the steps that need it`);
      }
    }
  }
  for (const step of workflowSteps(text)) {
    const envKeys = keysOf(step.env);
    const run = uncommented(step.run);
    for (const key of envKeys.filter((key) => PASSWORD.test(key))) {
      problems.push(
        `"${step.name}" sets ${key} in its env; take a kafka-credentials.sh scope instead`,
      );
    }
    for (const line of run.split('\n')) {
      if (!line.includes('GITHUB_ENV')) continue;
      if (PASSWORD.test(line)) {
        problems.push(`"${step.name}" exports a Kafka password to later steps: ${line.trim()}`);
      }
      for (const dir of SECRETS_DIRS.filter((dir) => line.includes(dir))) {
        problems.push(`"${step.name}" exports ${dir} to later steps: ${line.trim()}`);
      }
    }
    if (/kafka-credentials\.sh admin\b/.test(run) && step.name !== ADMIN_SCOPE_STEP) {
      problems.push(`"${step.name}" takes the admin scope, which only "${ADMIN_SCOPE_STEP}" may`);
    }
    if (
      (envKeys.includes('KAFKA_ADMIN_SECRETS_DIR') || run.includes('KAFKA_ADMIN_SECRETS_DIR')) &&
      ![ADMIN_SCOPE_STEP, BOOTSTRAP_STEP].includes(step.name)
    ) {
      problems.push(
        `"${step.name}" is given KAFKA_ADMIN_SECRETS_DIR, which only "${BOOTSTRAP_STEP}" and "${ADMIN_SCOPE_STEP}" may be`,
      );
    }
    if (
      envKeys.includes('KAFKA_SECRETS_DIR') &&
      !/kafka-credentials\.sh|kafka\/ci-up\.sh/.test(run)
    ) {
      problems.push(
        `"${step.name}" is given KAFKA_SECRETS_DIR but calls neither kafka-credentials.sh nor ci-up.sh`,
      );
    }
    if (!run.includes('dist/main.js')) continue;
    // A step that starts services: the directory leaves the environment
    // before the first process is launched, so none inherits it.
    const unset = run.indexOf('unset KAFKA_SECRETS_DIR');
    const firstLaunch = Math.min(
      ...['cd services/', 'dist/main.js']
        .map((marker) => run.indexOf(marker))
        .filter((i) => i >= 0),
    );
    if (
      (envKeys.includes('KAFKA_SECRETS_DIR') || run.includes('KAFKA_SECRETS_DIR')) &&
      (unset < 0 || unset > firstLaunch)
    ) {
      problems.push(`"${step.name}" starts services without first unsetting KAFKA_SECRETS_DIR`);
    }
    // Each service with its own password only.
    if (/kafka-credentials\.sh (tests|admin|observer)\b/.test(run)) {
      problems.push(`"${step.name}" starts services with a scope wider than one service's own`);
    }
    for (const name of [...BOOTSTRAP_ONLY, ...TOOLS]) {
      if (run.includes(`KAFKA_SASL_PASSWORD_${name}`)) {
        problems.push(`"${step.name}" starts services and names KAFKA_SASL_PASSWORD_${name}`);
      }
    }
    const lines = run.split('\n');
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
