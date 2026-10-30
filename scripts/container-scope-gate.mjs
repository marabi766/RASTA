#!/usr/bin/env node
// The "Images built and scanned" check: the one stable name the merge host
// can require on the train pull request (it passes without scanning on an
// ordinary one; contract in the header of .github/workflows/ci.yml). Reads the
// job's toJSON(needs) from NEEDS.
import { appendFileSync } from 'node:fs';
import { imagesGateVerdict } from './container-scope-lib.mjs';

let needs;
try {
  needs = JSON.parse(process.env.NEEDS ?? '');
} catch {
  needs = undefined;
}
const { ok, message } = imagesGateVerdict(needs);
console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Images built and scanned: ${ok ? 'success' : 'FAILED'}\n\n${message}\n`,
  );
}
if (!ok) {
  console.error(`::error::Images built and scanned: ${message}`);
  process.exitCode = 1;
}
