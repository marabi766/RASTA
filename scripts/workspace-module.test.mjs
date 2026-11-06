import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { loadWorkspaceModule } from './workspace-module.mjs';

test('workspace loader accepts the local config and refuses dependencies, outsiders and URLs', () => {
  assert.ok(loadWorkspaceModule('../services/identity-service/jest.config.js').projects);
  for (const path of [
    'undici',
    'node:http',
    'data:text/javascript,fetch(url)',
    '../node_modules/typescript/lib/typescript.js',
    './raw-http-boundary-rule.mjs',
    '/etc/passwd',
  ])
    assert.throws(() => loadWorkspaceModule(path), undefined, path);
  const fixture = mkdtempSync(new URL('../packages/loader-probe-', import.meta.url));
  try {
    mkdirSync(`${fixture}/dist`);
    symlinkSync(
      new URL('../node_modules/typescript/lib/typescript.js', import.meta.url),
      `${fixture}/dist/index.js`,
    );
    assert.throws(
      () => loadWorkspaceModule(`${fixture}/dist/index.js`),
      /Workspace module load refused/,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
