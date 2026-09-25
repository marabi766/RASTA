/**
 * Fails the build when a service ships an image CI never builds or scans.
 *
 * Sits in `pnpm verify` and in the CI quality job, both of which run on every
 * pull request. The `containers` job now also runs on pull requests, but only
 * for the images a change affects, so this remains the check that *every*
 * shipped image is in scope on main.
 *
 * See `ci-image-matrix-lib.mjs` for why this is derived rather than listed.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  CONTAINERS_JOB,
  compareCoverage,
  discoverDockerfileServices,
  formatFindings,
  hasFindings,
  resolveMatrixServices,
} from './ci-image-matrix-lib.mjs';

const root = process.cwd();
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');

const workflow = await readFile(workflowPath, 'utf8');

let dockerfileServices;
let matrixServices;
try {
  dockerfileServices = discoverDockerfileServices(root);
  // The real scope script, exactly as the container-scope job runs it on main.
  matrixServices = resolveMatrixServices(workflow, () =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(root, 'scripts', 'container-scope.mjs'), '--all'], {
        encoding: 'utf8',
      }),
    ),
  );
} catch (error) {
  process.stderr.write(
    `Image scan coverage gate could not run: ${error.message}\n` +
      'This is a failure, not a pass — the gate cannot confirm coverage it was unable to read.\n',
  );
  process.exit(1);
}

const findings = compareCoverage(dockerfileServices, matrixServices);

if (hasFindings(findings)) {
  process.stderr.write(
    `${formatFindings(findings)}\n\n` +
      `Every tracked services/*/Dockerfile must appear in the '${CONTAINERS_JOB}' matrix in ` +
      '.github/workflows/ci.yml, and every matrix entry must have one.\n',
  );
  process.exit(1);
}

process.stdout.write(
  `Image scan coverage gate: ${dockerfileServices.length} tracked Dockerfiles, ` +
    `all present in the '${CONTAINERS_JOB}' matrix.\n`,
);
