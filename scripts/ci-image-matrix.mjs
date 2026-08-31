/**
 * Fails the build when a service ships an image CI never builds or scans.
 *
 * Sits in `pnpm verify` and in the CI quality job, both of which run on every
 * pull request — deliberately, because the `containers` job that would surface
 * the problem only runs on a push to main. Catching it at PR time is the whole
 * point: by the time main is red, the image has already merged unscanned.
 *
 * See `ci-image-matrix-lib.mjs` for why this is derived rather than listed.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  CONTAINERS_JOB,
  compareCoverage,
  discoverDockerfileServices,
  extractMatrixServices,
  formatFindings,
  hasFindings,
} from './ci-image-matrix-lib.mjs';

const root = process.cwd();
const workflowPath = path.join(root, '.github', 'workflows', 'ci.yml');

const workflow = await readFile(workflowPath, 'utf8');

let dockerfileServices;
let matrixServices;
try {
  dockerfileServices = discoverDockerfileServices(root);
  matrixServices = extractMatrixServices(workflow, CONTAINERS_JOB);
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
