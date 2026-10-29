import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeShell } from './check-dockerfile-pins-lib.mjs';
import { JEST_LAUNCHERS } from './disclosure-jest-launchers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const CONFIG_FLAG =
  /^(?:--(?:config|projects|preset|rootDir|root-dir|setupFilesAfterEnv|setup-files-after-env)(?:=|$)|-c)/;
const SCRIPT_FILE = /\.(?:sh|bash|mjs|cjs|js|ts)$/;

/** Deliberately a token pre-check, not an interpreter. False positives need a reviewed registry row. */
export function launcherCandidate(source, path) {
  if (/\.(?:sh|bash)$/.test(path))
    return tokenizeShell(source).commands.some(({ words }) =>
      /\bjest\b|\b(?:pnpm|npm)\b[\s\S]*\btest\b/.test(words.map(({ value }) => value).join(' ')),
    );
  const ts = require('typescript');
  const identifiers = [];
  const literals = [];
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node.text);
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      literals.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const tokens = [...identifiers, ...literals].join(' ');
  return (
    (literals.includes('node:child_process') ||
      literals.includes('child_process') ||
      literals.includes('execa') ||
      identifiers.some((word) => /^(?:spawn\w*|exec\w*|fork)$/.test(word))) &&
    (/\bjest\b/.test(tokens) ||
      (literals.some((value) => /^(?:pnpm|npm|turbo)$/.test(value)) &&
        literals.some((value) => /^test(?::[\w-]+)?$/.test(value))) ||
      literals.some((value) => /\b(?:pnpm|npm)\s+(?:run\s+)?test(?::|\b)/.test(value)))
  );
}

/** Discover launches; unsupported configuration forwarding or file launchers are refusal records. */
export function jestCommands(paths, read) {
  const yaml = require('yaml');
  const packages = paths
    .filter((path) => /(^|\/)package\.json$/.test(path))
    .map((path) => ({
      path,
      pkg: JSON.parse(read(path)),
      directory: dirname(path),
    }));
  const commands = [];
  const refuse = (name, reason) => commands.push({ name, opaque: true, reason });
  const inspect = (script, name, directory, stack = [], inheritedOpaque = false) => {
    if (stack.length > 30) {
      refuse(name, 'recursive launcher');
      return;
    }
    const parsed = tokenizeShell(subshells(script));
    let cwd = directory;
    for (const command of parsed.commands) {
      for (const nested of parsed.nested.filter(
        ({ line }) => line >= command.startLine && line <= command.endLine,
      ))
        inspect(nested.script, name, cwd, [...stack, 'substitution']);
      const words = command.words.map(({ value }) => value);
      const opaque =
        inheritedOpaque || command.words.some(({ value, opaque }) => opaque || value.includes('$'));
      const executable = words.findIndex((word) => !/^[\w]+=.*/.test(word));
      const bin = words[executable]?.split('/').at(-1);
      if (bin === '__disclosure_subshell__') {
        inspect(words[executable + 1], name, cwd, [...stack, 'subshell']);
        continue;
      }
      if (bin === 'cd') {
        cwd = resolve(root, cwd, words[executable + 1] ?? '.');
        continue;
      }
      // Shell -c is a shell option, never Jest's -c. Recurse regardless of the flags inside it.
      const shellIndex = words.findIndex((word) =>
        ['bash', 'sh', 'dash', 'zsh'].includes(word.split('/').at(-1)),
      );
      if (
        shellIndex >= 0 &&
        words.some((word, index) => index > shellIndex && /^-[^-]*c/.test(word))
      ) {
        const index = words.findIndex((word, index) => index > shellIndex && /^-[^-]*c/.test(word));
        if (!words[index + 1]) refuse(name, 'missing shell body');
        else inspect(words[index + 1], name, cwd, [...stack, 'shell'], inheritedOpaque);
        continue;
      }
      const jestIndex = words.findIndex((word) => /(?:^|\/)jest(?:\.js)?$/.test(word));
      const managerIndex = words.findIndex((word) => /(?:^|\/)(?:pnpm|npm|turbo)$/.test(word));
      let selected = cwd;
      let selectionOpaque = false;
      const consumed = new Set();
      let selectors = 0;
      for (let i = managerIndex + 1; managerIndex >= 0 && i < words.length; i++) {
        const match = /^(--filter|-F|--dir|-C|--prefix|--workspace|-w)(?:=(.*))?$/.exec(words[i]);
        if (!match) continue;
        selectors++;
        const value = match[2] ?? words[i + 1];
        consumed.add(i);
        if (match[2] === undefined) consumed.add(++i);
        if (['--filter', '-F', '--workspace', '-w'].includes(match[1])) {
          selected = packages.find(({ pkg }) => pkg.name === value)?.directory;
        } else selected = value && resolve(root, cwd, value);
        selectionOpaque ||= selectors > 1 || !selected || /[$*{}]/.test(value ?? '');
      }
      const add = (args, dir = selected, isOpaque = opaque || selectionOpaque) =>
        commands.push({
          name,
          directory: dir && resolve(root, dir),
          args,
          opaque: isOpaque,
        });
      if (jestIndex >= 0) {
        // Unknown prefix options can change cwd or script dispatch: never assume they are inert.
        selectionOpaque ||= words
          .slice(0, jestIndex)
          .some((word, index) => word.startsWith('-') && word !== '--' && !consumed.has(index));
        if (managerIndex >= 0) {
          const dispatch = words
            .slice(managerIndex + 1, jestIndex)
            .filter((word, offset) => !consumed.has(managerIndex + 1 + offset) && word !== '--');
          selectionOpaque ||= !(
            dispatch.length === 0 ||
            (dispatch.length === 1 && dispatch[0] === 'exec')
          );
        }
        add(words.slice(jestIndex + 1).filter((word) => word !== '--'));
        continue;
      }
      // Only executable/runner operands are launcher files, not Jest spec/config arguments.
      const runner = words.some((word) =>
        ['node', 'bash', 'sh', 'dash', 'zsh', 'tsx', 'ts-node'].includes(word.split('/').at(-1)),
      );
      const fileIndex = runner
        ? words.findIndex(
            (word, index) => index > executable && !word.startsWith('-') && SCRIPT_FILE.test(word),
          )
        : SCRIPT_FILE.test(words[executable] ?? '')
          ? executable
          : -1;
      for (const index of runner
        ? words.flatMap((word, index) => (SCRIPT_FILE.test(word) ? [index] : []))
        : fileIndex >= 0
          ? [fileIndex]
          : []) {
        const path = relative(root, resolve(root, cwd, words[index]));
        let source;
        try {
          source = read(path);
          if (typeof source !== 'string') throw new Error('unreadable source');
        } catch {
          // A statically absent executable cannot launch Jest. Unreadable existing sources refuse.
          if (paths.includes(path) || /[$]/.test(words[index]))
            refuse(name, `unreadable launcher ${path}`);
          continue;
        }
        const entry = JEST_LAUNCHERS[path];
        if (!entry && !launcherCandidate(source, path)) continue;
        if (!entry) {
          refuse(name, `unregistered Jest launcher ${path}`);
          continue;
        }
        let valid = true;
        for (const [file, expected] of Object.entries(entry.sha256)) {
          try {
            if (createHash('sha256').update(read(file)).digest('hex') !== expected) valid = false;
          } catch {
            valid = false;
          }
        }
        if (!valid) {
          refuse(name, `changed/unreadable registered launcher ${path}`);
          continue;
        }
        const args = words.slice(index + 1);
        // Registered adapters accept only the reviewed argument grammar; forwarding elsewhere refuses.
        if (opaque) {
          refuse(name, `opaque launcher ${path}`);
          continue;
        }
        if (entry.kind === 'independence') {
          const [packageDir, pattern, ...rest] = args;
          if (
            !packageDir ||
            !pattern ||
            !packages.some(
              (pkg) => resolve(root, pkg.directory) === resolve(root, cwd, packageDir),
            ) ||
            !(rest.length === 0 || (rest.length === 2 && rest[0] === '--project')) ||
            args.some((arg) => CONFIG_FLAG.test(arg))
          ) {
            refuse(name, `unsupported independence arguments`);
            continue;
          }
          add(
            ['--selectProjects', rest[1] ?? 'integration', '--runInBand', '--json'],
            resolve(root, cwd, packageDir),
          );
        } else if (entry.kind === 'phases') {
          const [task, ...rest] = args;
          if (!['test', 'test:integration'].includes(task) || (rest.length && rest[0] !== '--')) {
            refuse(name, 'unsupported test phases arguments');
            continue;
          }
          inspect(`turbo run ${task} -- ${rest.slice(1).map(quote).join(' ')}`, name, '.', [
            ...stack,
            path,
          ]);
          if (task === 'test:integration')
            inspect(
              `pnpm --filter @rasta/identity-service test:aggregation-stress -- ${rest.slice(1).map(quote).join(' ')}`,
              name,
              '.',
              [...stack, path],
            );
        } else if (entry.kind === 'evidence') {
          if (args.some((arg) => CONFIG_FLAG.test(arg))) {
            refuse(name, 'unsupported evidence configuration arguments');
            continue;
          }
          add(
            ['--selectProjects', 'aggregation-stress', '--runInBand', '--json'],
            'services/identity-service',
          );
          inspect('pnpm run test:aggregation-stress -- --json', name, '.', [...stack, path]);
        } else if (entry.kind !== 'non-jest' || args.some((arg) => CONFIG_FLAG.test(arg)))
          refuse(name, `unsupported registered launcher ${path}`);
        continue;
      }
      if (fileIndex >= 0) continue;
      // Defaults are scanned as package scripts below; forwarded configuration must be expanded here.
      const override = words.some(
        (word, index) => index > managerIndex && !consumed.has(index) && CONFIG_FLAG.test(word),
      );
      if (
        managerIndex >= 0 &&
        (override ||
          stack.includes('scripts/run-test-phases.mjs') ||
          stack.includes('scripts/aggregation-evidence.mjs'))
      ) {
        if (opaque || selectionOpaque) {
          refuse(name, 'unresolved forwarded Jest configuration');
          continue;
        }
        const operands = words
          .slice(managerIndex + 1)
          .filter((word, offset) => !consumed.has(managerIndex + 1 + offset));
        if (['run', 'run-script'].includes(operands[0])) operands.shift();
        const task = operands.shift();
        const args = operands;
        const targets =
          words[managerIndex].split('/').at(-1) === 'turbo'
            ? packages.filter(
                ({ pkg, directory }) => directory !== '.' && Object.hasOwn(pkg.scripts ?? {}, task),
              )
            : packages.filter(
                ({ directory, pkg }) =>
                  resolve(root, directory) === resolve(root, selected ?? '.') &&
                  Object.hasOwn(pkg.scripts ?? {}, task),
              );
        if (
          !targets.length ||
          targets.some((target) => stack.includes(`${target.directory}:${task}`))
        ) {
          refuse(name, 'unresolved forwarded package script');
          continue;
        }
        for (const target of targets)
          inspect(
            `${target.pkg.scripts[task]} ${args.map(quote).join(' ')}`,
            name,
            target.directory,
            [...stack, `${target.directory}:${task}`],
          );
      } else if (
        (bin?.includes('$') && words.some((word) => CONFIG_FLAG.test(word))) ||
        words.some(
          (word) => /\s/.test(word) && /\bjest\b|\b(?:pnpm|npm)\b[\s\S]*\btest\b/.test(word),
        )
      )
        refuse(name, 'unsupported shell/inline configuration launcher');
    }
  };
  for (const { path, pkg, directory } of packages)
    for (const [name, script] of Object.entries(pkg.scripts ?? {}))
      inspect(script, `${path} script ${name}`, directory);
  for (const path of paths.filter((path) =>
    /^\.github\/(?:workflows\/.*\.ya?ml|actions\/(?:.*\/)?action\.ya?ml)$/.test(path),
  )) {
    const workflow = yaml.parse(read(path));
    const steps = (steps, label, directory) => {
      for (const [index, step] of (steps ?? []).entries())
        if (typeof step.run === 'string')
          inspect(
            step.run,
            `${path} ${label} step ${index}`,
            step['working-directory'] ?? directory,
          );
    };
    for (const [name, job] of Object.entries(workflow.jobs ?? {}))
      steps(
        job.steps,
        name,
        job.defaults?.run?.['working-directory'] ??
          workflow.defaults?.run?.['working-directory'] ??
          '.',
      );
    if (workflow.runs?.using === 'composite') steps(workflow.runs.steps, 'composite', '.');
  }
  return commands;
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Preserve subshell cwd boundaries before using the shared shell tokenizer. */
function subshells(source) {
  let result = '';
  let quoteState = null;
  const close = (start) => {
    let depth = 1;
    let quote = null;
    for (let i = start + 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')' && --depth === 0) return i;
      if (ch === ')' && depth < 0) break;
    }
    throw new Error('unclosed shell group');
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      result += source.slice(i, i + 2);
      i++;
      continue;
    }
    if (quoteState) {
      result += ch;
      if (ch === quoteState) quoteState = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoteState = ch;
      result += ch;
      continue;
    }
    if (ch === '#') {
      const end = source.indexOf('\n', i);
      if (end < 0) {
        result += source.slice(i);
        break;
      }
      result += source.slice(i, end);
      i = end - 1;
      continue;
    }
    if (ch === '$' && source[i + 1] === '(') {
      const end = close(i + 1);
      result += source.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '(') {
      const end = close(i);
      result += `; __disclosure_subshell__ ${quote(source.slice(i + 1, end))}; `;
      i = end;
      continue;
    }
    result += ch;
  }
  return result;
}
