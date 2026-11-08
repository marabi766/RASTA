import fs from 'node:fs';
import path from 'node:path';

/**
 * A TypeScript parser that gives `internal/token-source` type information
 * wherever a workspace's own TypeScript project covers the file, and parses
 * everything else without it rather than failing (PR #423 follow-up 1).
 *
 * The project is the linted file's workspace (nearest `package.json`):
 * `tsconfig.test.json` where one exists — it covers `src`, `test`, `dev` and
 * the seed — otherwise `tsconfig.json`. A file no project includes (JavaScript,
 * a stray `.ts`), or text that is not what is on disk (stdin, an editor
 * buffer: the project would type the file on disk instead), still parses; the
 * rule then has no program and reports, fail closed, every construct it could
 * only clear with types. A syntax error is reported as before.
 *
 * `base` is the caller's own `@typescript-eslint/parser`, so the portal's
 * config (which cannot load the root one) wraps the same parser it already uses.
 */
export function typedOrUntypedParser(base) {
  const projects = new Map();

  const projectFor = (filePath) => {
    let dir = path.dirname(path.resolve(filePath));
    const visited = [];
    for (;;) {
      if (projects.has(dir)) break;
      visited.push(dir);
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const tsconfig = ['tsconfig.test.json', 'tsconfig.json']
          .map((name) => path.join(dir, name))
          .find((candidate) => fs.existsSync(candidate));
        projects.set(dir, tsconfig ? { dir, tsconfig } : null);
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        projects.set(dir, null);
        break;
      }
      dir = parent;
    }
    const found = projects.get(dir);
    for (const seen of visited) projects.set(seen, found);
    return found;
  };

  const untyped = (code, options) =>
    base.parseForESLint(code, {
      ...options,
      project: undefined,
      projectService: false,
      programs: undefined,
    });

  return {
    meta: { name: 'internal-token-typed-or-untyped-parser' },
    parseForESLint(code, options = {}) {
      const project = options.filePath ? projectFor(options.filePath) : null;
      if (!project) return untyped(code, options);
      // The project reads the file from disk: its types describe this code
      // only when this code is what is on disk (not an editor buffer or stdin).
      if (fs.existsSync(options.filePath) && fs.readFileSync(options.filePath, 'utf8') !== code) {
        return untyped(code, options);
      }
      try {
        return base.parseForESLint(code, {
          ...options,
          projectService: false,
          project: project.tsconfig,
          tsconfigRootDir: project.dir,
        });
      } catch (error) {
        // Only "no project covers this file" falls back — the project does not
        // include it, or includes nothing (the root's `"include": []`). Anything
        // else (a syntax error) is the file's own problem and is reported.
        if (
          !/does not include this file|parserOptions\.project|not found by the project service|TS18003/i.test(
            String(error?.message),
          )
        ) {
          throw error;
        }
        return untyped(code, options);
      }
    },
  };
}
