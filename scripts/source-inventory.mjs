import { fixtureGitEnv } from './fixture-git-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import tseslint from 'typescript-eslint';
import { isExecutable } from './lint-extensions.mjs';

/** NUL records preserve Git paths verbatim, including names Git normally quotes. */
export function trackedFiles(cwd) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: fixtureGitEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout === '' || result.stdout.endsWith('\0'), 'incomplete Git inventory');
  return result.stdout.split('\0').filter(Boolean);
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

const DIRECTIVE = /^\s*eslint(-disable(?:-next-line|-line)?|-enable)?(?=\s|$)([\s\S]*)/;
/** Parse real comments, including their complete bodies; syntax failures refuse. */
export function transportDirectives(files, read, pinnedFile) {
  const found = [];
  for (const file of files.filter(isExecutable)) {
    let comments;
    let source;
    try {
      source = read(file).replace(/\r\n?/g, '\n');
      comments = tseslint.parser.parseForESLint(source, {
        filePath: file,
        project: false,
        projectService: false,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        comment: true,
      }).ast.comments;
      assert.ok(Array.isArray(comments), 'parser did not classify comments');
    } catch {
      found.push(`${file}: unclassifiable source`);
      continue;
    }
    for (const comment of comments) {
      // Also refuse directive-shaped JSDoc; never treat a nested-looking opener
      // or a quoted comment delimiter as a separate comment.
      const match = comment.value.replace(/^\s*\*/gm, '').match(DIRECTIVE);
      if (!match) continue;
      const rules = match[2].split(/\s--\s/)[0].trim();
      // Only a simple list of unrelated rule names is proven safe. General
      // inline configuration (quoted/escaped keys, values, etc.) is refused.
      const names = rules.split(/\s*,\s*/);
      if (
        file === pinnedFile ||
        !match[1] ||
        names.some((name) => !/^[@\w/-]+$/.test(name) || name.startsWith('internal/'))
      )
        found.push(
          `${file}:${comment.loc.start.line}:${comment.loc.start.column} ${comment.type} eslint${match[1] ?? ''}: ${rules || '(all rules)'} sha256:${digest(comment.value)}:${digest(source.split('\n')[comment.loc.end.line - (match[1] === '-disable-next-line' ? 0 : 1)] ?? '')}`,
        );
    }
  }
  return found;
}
