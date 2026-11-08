// -----------------------------------------------------------------------------
// The restoration of a queued event's provenance is the registration intake's
// only (PR #483 r3 F2).
//
//   pnpm test:outbox-provenance-restoration-guard
//
// An ordinary event takes its actor and correlation id from the verified
// request context and from nothing its producer supplies (`buildOutboxRow`).
// Work queued past its request — the registration intake — captures the
// request's provenance, persists it, and restores it for the event: the one
// place a provenance enters an event any other way. That path is
// `restoreOutboxProvenance` (a persisted capture back as an issued provenance)
// and `buildRestoredOutboxRow` (an event from one), in @rasta/nest-common, and
// identity's `enqueueRestoredEvent` over them. Each may be named only by the
// files in ALLOWED below; a new file that names one fails here, and so does an
// entry that no longer names it. Names are matched as identifiers and as
// string keys (`x['restoreOutboxProvenance']`), never in comments.
// -----------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './url-parsing-guard-lib.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/outbox-provenance-restoration-guard.test.mjs';

/** The restoration path, by name. */
export const RESTRICTED = Object.freeze([
  'restoreOutboxProvenance',
  'buildRestoredOutboxRow',
  'enqueueRestoredEvent',
]);

/** Each file allowed to name a restricted name, and why. */
const ALLOWED = Object.freeze({
  restoreOutboxProvenance: {
    'packages/nest-common/src/outbox/outbox-provenance.ts': 'its definition',
    'packages/nest-common/src/index.ts': 'the package export',
    'packages/nest-common/src/outbox/outbox-provenance.spec.ts': 'its own tests',
    'services/identity-service/src/identity/identity.repository.ts':
      'the registration intake: lockRegistrationIntake restores the row it stored',
  },
  buildRestoredOutboxRow: {
    'packages/nest-common/src/outbox/outbox.ts': 'its definition',
    'packages/nest-common/src/index.ts': 'the package export',
    'packages/nest-common/src/outbox/outbox-provenance.spec.ts': 'its own tests',
    'services/identity-service/src/identity/identity.repository.ts':
      'the registration intake: enqueueRestoredEvent',
  },
  enqueueRestoredEvent: {
    'services/identity-service/src/identity/identity.repository.ts': 'its definition',
    'services/identity-service/src/identity/identity.service.ts':
      'processRegistrationIntake, the registration worker’s step',
    'services/identity-service/src/identity/enqueue-provenance.spec.ts': 'its own tests',
  },
});

const SCRIPT_KINDS = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

/** The restricted names `text` names: identifiers and exact string keys, not comments. */
export function restrictedNames(text, file) {
  const kind = SCRIPT_KINDS[extname(file)] ?? ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found = new Set();
  const visit = (node) => {
    if (
      ts.isIdentifier(node) ||
      ts.isPrivateIdentifier(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      if (RESTRICTED.includes(node.text)) found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('the scanner: an identifier, an import, a string key; not a comment or a longer name', () => {
  assert.deepEqual(
    [...restrictedNames("import { restoreOutboxProvenance } from '@rasta/nest-common';", 'a.ts')],
    ['restoreOutboxProvenance'],
  );
  assert.deepEqual(
    [...restrictedNames("const f = common['buildRestoredOutboxRow'];", 'a.ts')],
    ['buildRestoredOutboxRow'],
  );
  assert.deepEqual(
    [...restrictedNames('repo.enqueueRestoredEvent(tx, i, p);', 'a.mjs')],
    ['enqueueRestoredEvent'],
  );
  assert.equal(
    restrictedNames('// restoreOutboxProvenance\n/* buildRestoredOutboxRow */', 'a.ts').size,
    0,
  );
  assert.equal(
    restrictedNames('restoreOutboxProvenanceLater(); x.enqueueRestoredEvents;', 'a.ts').size,
    0,
  );
});

test('only the registration intake names the restoration path', () => {
  const unlisted = [];
  const seen = Object.fromEntries(RESTRICTED.map((name) => [name, new Set()]));
  for (const file of sourceFiles(ROOT)) {
    if (file === SELF) continue;
    for (const name of restrictedNames(readFileSync(join(ROOT, file), 'utf8'), file)) {
      seen[name].add(file);
      if (!(file in ALLOWED[name])) unlisted.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(unlisted, [], 'files outside the registration intake name its restoration path');

  const stale = [];
  for (const name of RESTRICTED) {
    for (const file of Object.keys(ALLOWED[name])) {
      if (!seen[name].has(file)) stale.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(stale, [], 'allow-list entries that no longer name it');
});
