/**
 * Keeps the container build/Trivy matrix honest about what we actually ship.
 *
 * Three times now a service has landed with a Dockerfile and simply not been
 * added to the `containers` matrix in `.github/workflows/ci.yml`:
 * asset-service and fleet-service (PROJECT_MEMORY § 22), then document-service
 * after PR #14. Each time the pipeline stayed green, because a matrix that
 * never mentions an image cannot fail on it. The gap is invisible by
 * construction — which is exactly the kind of gap that needs a test rather
 * than a habit.
 *
 * So this compares two sets that are both derived, never written down twice:
 *
 *   - the services that ship an image  — `git ls-files services/<name>/Dockerfile`
 *   - the services the matrix scans    — parsed out of the workflow itself
 *
 * There is deliberately no list of service names anywhere in this file or its
 * test. A hard-coded list would be a third place to forget to update, and the
 * guard would then pass while being wrong.
 *
 * Only `services/*` is discovered. `apps/*` ships no Dockerfile today; when
 * one lands, this scope is the thing to widen, and the widening is one line.
 */

import { execFileSync } from 'node:child_process';

/** The workflow job that builds and scans images. */
export const CONTAINERS_JOB = 'containers';

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

/**
 * Drops a trailing `# comment`, which the matrix block genuinely carries.
 *
 * Only strips at a boundary so a `#` inside a value would survive. No service
 * name contains one, but a parser that quietly eats characters is how you get
 * an empty list and a gate that passes because it found nothing.
 */
function stripComment(line) {
  return line.replace(/(^|\s)#.*$/, '$1');
}

function cleanItem(raw) {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

/**
 * Returns the lines belonging to one job, by indentation.
 *
 * Anchored on the job key at its own indent and stopping at the next line that
 * is no deeper, so it cannot run past the job it was asked for.
 */
function jobBlock(workflowYaml, jobName) {
  const lines = workflowYaml.split(/\r?\n/);
  const header = new RegExp(`^\\s+${jobName}:\\s*$`);
  const matches = lines.filter((line) => header.test(line));
  if (matches.length === 0) {
    throw new Error(`workflow has no '${jobName}:' job`);
  }
  if (matches.length > 1) {
    throw new Error(
      `workflow declares '${jobName}:' ${matches.length} times; this guard cannot tell which one builds images`,
    );
  }

  const start = lines.findIndex((line) => header.test(line));
  const jobIndent = indentOf(lines[start]);
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    if (indentOf(line) <= jobIndent) break;
    body.push(line);
  }
  return body;
}

/**
 * Reads the matrix service names out of the workflow text.
 *
 * Accepts either YAML sequence style — the flow form the file uses today
 * (`service: [a, b]`, wrapped by Prettier across lines) or a block form
 * (`- a`) — so a reformat does not silently defeat the guard.
 *
 * Throws rather than returning `[]` on anything it does not understand. An
 * empty result would make every comparison below trivially pass.
 */
export function extractMatrixServices(workflowYaml, jobName = CONTAINERS_JOB) {
  const lines = jobBlock(workflowYaml, jobName);
  const start = lines.findIndex((line) => /^\s*service:/.test(stripComment(line)));
  if (start === -1) {
    throw new Error(`the '${jobName}' job has no matrix 'service:' key`);
  }

  const keyIndent = indentOf(lines[start]);
  const region = [stripComment(lines[start]).replace(/^\s*service:/, '')];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= keyIndent) break;
    region.push(stripComment(lines[i]));
  }
  const text = region.join('\n');

  const open = text.indexOf('[');
  let items;
  if (open !== -1) {
    const close = text.indexOf(']', open);
    if (close === -1) {
      throw new Error(`the '${jobName}' matrix service list opens with '[' but never closes`);
    }
    items = text.slice(open + 1, close).split(',');
  } else {
    items = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-'))
      .map((line) => line.replace(/^-\s*/, ''));
  }

  const services = items.map(cleanItem).filter((item) => item !== '');
  if (services.length === 0) {
    throw new Error(`the '${jobName}' matrix service list parsed as empty`);
  }
  return services;
}

/**
 * The services that ship an image, from git rather than from the filesystem.
 *
 * `git ls-files` answers "what does the repository contain", which is what CI
 * will check out. A Dockerfile that exists only in a working tree is not yet
 * something the pipeline can build, and should not fail this gate.
 */
export function discoverDockerfileServices(cwd = process.cwd()) {
  const stdout = execFileSync('git', ['ls-files', 'services/*/Dockerfile'], {
    cwd,
    encoding: 'utf8',
  });
  const services = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => file.split('/')[1]);

  if (services.length === 0) {
    throw new Error('no tracked services/*/Dockerfile found; refusing to pass on an empty set');
  }
  return services;
}

/**
 * Set comparison, both directions.
 *
 * The reverse direction matters as much as the forward one: a matrix entry for
 * a service whose Dockerfile was renamed or removed fails the job at build
 * time with a confusing "file not found" rather than naming the real problem.
 */
export function compareCoverage(dockerfileServices, matrixServices) {
  const dockerfiles = new Set(dockerfileServices);
  const matrix = new Set(matrixServices);

  return {
    missingFromMatrix: [...dockerfiles].filter((name) => !matrix.has(name)).sort(),
    staleInMatrix: [...matrix].filter((name) => !dockerfiles.has(name)).sort(),
    duplicateMatrixEntries: matrixServices
      .filter((name, index) => matrixServices.indexOf(name) !== index)
      .sort(),
  };
}

export function hasFindings(findings) {
  return (
    findings.missingFromMatrix.length > 0 ||
    findings.staleInMatrix.length > 0 ||
    findings.duplicateMatrixEntries.length > 0
  );
}

/** Names every offending service, so the failure is actionable without digging. */
export function formatFindings(findings) {
  const lines = [];
  if (findings.missingFromMatrix.length > 0) {
    lines.push(
      `Dockerfiles missing from the ${CONTAINERS_JOB} matrix (never built, never scanned):`,
      ...findings.missingFromMatrix.map((name) => `  - ${name} (services/${name}/Dockerfile)`),
    );
  }
  if (findings.staleInMatrix.length > 0) {
    lines.push(
      `Stale ${CONTAINERS_JOB} matrix entries with no tracked Dockerfile:`,
      ...findings.staleInMatrix.map((name) => `  - ${name}`),
    );
  }
  if (findings.duplicateMatrixEntries.length > 0) {
    lines.push(
      `Duplicate ${CONTAINERS_JOB} matrix entries:`,
      ...findings.duplicateMatrixEntries.map((name) => `  - ${name}`),
    );
  }
  return lines.join('\n');
}
