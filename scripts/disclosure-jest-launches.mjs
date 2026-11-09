import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenizeShell } from './check-dockerfile-pins-lib.mjs';
import { SHELL_WORD, shellInvocation } from './ci-shell-text-lib.mjs';
import { JEST_LAUNCHERS } from './disclosure-jest-launchers.mjs';
import { planTestRun } from './test-phases-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const CONFIG_FLAG =
  /^(?:--(?:config|projects|preset|rootDir|root-dir|setupFilesAfterEnv|setup-files-after-env)(?:=|$)|-c)/;
const SCRIPT_FILE = /\.(?:sh|bash|mjs|cjs|js|ts)$/;

/**
 * Deliberately a token pre-check, not an interpreter. False positives need a reviewed registry
 * row. PR #805 r2 F3: a shell file (`shell`, or a .sh/.bash name) is read by the shared dispatch
 * reader, and a script that can start a process is a candidate unless every process it starts is
 * named by a plain string literal: the tokens of a computed command prove nothing.
 */
export function launcherCandidate(source, path, shell = false) {
  if (shell || /\.(?:sh|bash)$/.test(path)) return shellCandidate(source, 0);
  const ts = require('typescript');
  const identifiers = [];
  const literals = [];
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const launching = launchingProcesses(ts, ast);
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
    launching.computed ||
    ((literals.includes('node:child_process') ||
      literals.includes('child_process') ||
      literals.includes('execa') ||
      identifiers.some((word) => /^(?:spawn\w*|exec\w*|fork)$/.test(word))) &&
      (/\bjest\b/.test(tokens) ||
        (literals.some((value) => /^(?:pnpm|npm|turbo)$/.test(value)) &&
          literals.some((value) => /^test(?::[\w-]+)?$/.test(value))) ||
        literals.some((value) => /\b(?:pnpm|npm)\s+(?:run\s+)?test(?::|\b)/.test(value))))
  );
}

/**
 * PR #805 r2 F3: whether a script starts a process whose command is not a plain string literal.
 * The process-starting bindings are the names bound from child_process/execa (imports, requires,
 * dynamic imports, destructuring, aliases); a call through one must name its command by a
 * literal (or a name: `process.execPath`, a constant), and a binding used any other way (handed
 * to another function as a value) is computed too.
 */
function launchingProcesses(ts, ast) {
  const modules = /^(?:node:)?child_process$|^execa$/;
  const bound = new Set();
  const isModule = (node) => ts.isStringLiteralLike(node) && modules.test(node.text);
  const covered = new Set(); // module loads whose result is bound to a name
  const loads = (node) => {
    let current = node;
    while (current) {
      if (ts.isAwaitExpression(current) || ts.isParenthesizedExpression(current))
        current = current.expression;
      else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
        current = current.expression;
      else if (ts.isCallExpression(current)) {
        const [first] = current.arguments;
        if (first && isModule(first)) {
          covered.add(current);
          return true;
        }
        current = current.expression;
      } else return false;
    }
    return false;
  };
  const bind = (name) => {
    if (ts.isIdentifier(name)) bound.add(name.text);
    else
      for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  const declared = new Set();
  const collect = (node) => {
    if (ts.isImportDeclaration(node) && isModule(node.moduleSpecifier) && node.importClause) {
      const { name, namedBindings } = node.importClause;
      for (const local of [
        name,
        ...(namedBindings && ts.isNamespaceImport(namedBindings)
          ? [namedBindings.name]
          : (namedBindings?.elements ?? []).map((element) => element.name)),
      ]) {
        if (!local) continue;
        bound.add(local.text);
        declared.add(local);
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer && loads(node.initializer)) {
      bind(node.name);
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  // a module load whose result is not bound to a name (`import(…).then(({ spawn }) => …)`)
  let computed = false;
  const unbound = (node) => {
    const [first] = ts.isCallExpression(node) ? node.arguments : [];
    if (first && isModule(first) && !covered.has(node)) computed = true;
    ts.forEachChild(node, unbound);
  };
  unbound(ast);
  const root = (expression) => {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      current = current.expression;
    return current;
  };
  const callees = new Set();
  // A command that is a literal, the running node, or a name whose every declaration is one.
  const declarations = new Map();
  const declare = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
      declarations.set(node.name.text, [
        ...(declarations.get(node.name.text) ?? []),
        node.initializer,
      ]);
    else if (ts.isParameter(node) && ts.isIdentifier(node.name))
      declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), undefined]);
    ts.forEachChild(node, declare);
  };
  declare(ast);
  const plain = (expression, seen = new Set()) => {
    if (ts.isStringLiteralLike(expression)) return true;
    if (ts.isPropertyAccessExpression(expression))
      return expression.getText() === 'process.execPath';
    if (!ts.isIdentifier(expression) || seen.has(expression.text)) return false;
    const all = declarations.get(expression.text);
    return Boolean(
      all?.length && all.every((init) => init && plain(init, new Set([...seen, expression.text]))),
    );
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const base = root(node.expression);
      if (ts.isIdentifier(base) && bound.has(base.text)) {
        callees.add(base);
        const [command] = node.arguments;
        if (!command || !plain(command)) computed = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  // a launching binding that is not the root of a call (`run(spawn, …)`) hands the process out
  const references = (node) => {
    if (
      ts.isIdentifier(node) &&
      bound.has(node.text) &&
      !declared.has(node) &&
      !callees.has(node)
    ) {
      const parent = node.parent;
      const declaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const specifier = ts.isImportSpecifier(parent) || ts.isBindingElement(parent);
      if (!declaration && !specifier && !ts.isPropertyAccessExpression(parent)) computed = true;
      else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        !callees.has(node)
      )
        computed = true;
    }
    ts.forEachChild(node, references);
  };
  references(ast);
  return { computed };
}

/**
 * FU-077 r2 F2: every command of a shell file, nested ones included (substitutions, also in
 * `${…}`, `$((…))` and expanding here-documents, and here-documents fed to a shell). Text the
 * tokenizer cannot split is a candidate, so it reaches the registry and refuses.
 * PR #805 r2 F3: a shell inside it is read by the shared dispatch (shellInvocation): its -c body
 * is read as a script of its own, and a shell that reads a pipe, a computed text or another script
 * file is a candidate, because what it runs cannot be seen from here.
 */
function shellCandidate(source, depth) {
  let parsed;
  try {
    parsed = tokenizeShell(source);
  } catch {
    return true;
  }
  if (depth > 30) return true;
  const hides = ({ words, input }) => {
    const at = words.findIndex(({ value }) => SHELL_WORD.test(value));
    if (at < 0) return false;
    const run = shellInvocation(words.slice(at + 1), words[at].value);
    if (run.body) return shellCandidate(run.body.value, depth + 1);
    if (containerised(words.slice(0, at).map(({ value }) => value))) return false;
    if (run.problem || run.file) return true;
    const text = input.hereString;
    if (text) return text === true || computedWord(text) || shellCandidate(text.value, depth + 1);
    return Boolean(input.pipe);
  };
  return (
    parsed.commands.some(
      (command) =>
        /\bjest\b|\b(?:pnpm|npm)\b[\s\S]*\btest\b/.test(
          command.words.map(({ value }) => value).join(' '),
        ) || hides(command),
    ) || parsed.nested.some(({ script }) => shellCandidate(script, depth + 1))
  );
}

/** A shell after a docker word runs in the container's file system, not on the runner's. */
const containerised = (before) => before.some((word) => /(?:^|\/)docker(?:-compose)?$/.test(word));
const computedWord = (word) => Boolean(word.opaque || word.dynamic || word.value.includes('$'));

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
    let parsed;
    try {
      parsed = tokenizeShell(subshells(script));
    } catch {
      refuse(name, 'shell text the tokenizer cannot split');
      return;
    }
    let cwd = directory;
    // FU-077 r2 F2: a nested script outside every command's lines (an expanding here-document
    // body) is still read, after the commands.
    const unread = new Set(parsed.nested);
    for (const command of parsed.commands) {
      for (const nested of parsed.nested.filter(
        ({ line }) => line >= command.startLine && line <= command.endLine,
      )) {
        unread.delete(nested);
        inspect(nested.script, name, cwd, [...stack, 'substitution']);
      }
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
      // Shell -c is a shell option, never Jest's -c. FU-092: what a shell runs is decided by the
      // shared shellInvocation (`+c`, `+sc`, `-eo pipefail -c`, a computed option, `-`), never by
      // a pattern of its own; a shell that reads a pipe or a here-string reads text we inspect.
      const shellIndex = words.findIndex((word) => SHELL_WORD.test(word));
      // PR #805 r2 F3: the script operand of any recognised shell is a launcher file, resolved below
      // like every other one; the shared reader alone decides which word it is.
      let shellOperand = -1;
      if (shellIndex >= 0) {
        const run = shellInvocation(command.words.slice(shellIndex + 1), words[shellIndex]);
        if (run.problem) {
          refuse(name, run.problem);
          continue;
        }
        if (run.body) {
          inspect(run.body.value, name, cwd, [...stack, 'shell'], inheritedOpaque);
          continue;
        }
        if (run.stdin) {
          const text = command.input.hereString;
          if (text && !command.input.pipe) {
            if (text.opaque || text.value.includes('$')) refuse(name, 'computed shell input');
            else inspect(text.value, name, cwd, [...stack, 'shell'], inheritedOpaque);
            continue;
          }
          if (command.input.pipe) {
            refuse(name, 'a shell reading a pipe');
            continue;
          }
        }
        if (run.file && !containerised(words.slice(0, shellIndex)))
          shellOperand = command.words.indexOf(run.file);
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
      for (const index of shellOperand >= 0
        ? [shellOperand]
        : runner
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
          // A shell's script operand may be generated before the shell runs: it refuses too.
          if (shellOperand >= 0 || paths.includes(path) || /[$]/.test(words[index]))
            refuse(name, `unreadable launcher ${path}`);
          continue;
        }
        const entry = JEST_LAUNCHERS[path];
        if (!entry && !launcherCandidate(source, path, shellOperand >= 0)) continue;
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
        if (entry.workflowSteps) {
          try {
            const pin = entry.workflowSteps;
            const steps = yaml.parse(read(pin.file)).jobs[pin.job].steps;
            const selected = pin.names.map((name) => {
              const matches = steps.filter((step) => step.name === name);
              if (matches.length !== 1) throw new Error('missing/duplicate pinned step');
              return matches[0]; // Pin all step fields, including env/if/shell/failure handling.
            });
            if (createHash('sha256').update(JSON.stringify(selected)).digest('hex') !== pin.sha256)
              valid = false;
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
        // `inertArguments`: reviewed, no argument of this launcher reaches a Jest launch (an image ref).
        if (opaque && !entry.inertArguments) {
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
          let plan;
          try {
            plan = planTestRun(args);
          } catch {
            refuse(name, 'unsupported test phases arguments');
            continue;
          }
          // Use the pinned real planner: shard ownership and exclusive-phase
          // selection must match execution. Expand each positive filter separately
          // so every descendant reaches the effective Jest configuration adapter.
          for (const { args: phaseArgs } of plan) {
            const [, task, ...rest] = phaseArgs;
            const separator = rest.indexOf('--');
            const filters = separator < 0 ? rest : rest.slice(0, separator);
            const forwarded = separator < 0 ? [] : rest.slice(separator + 1);
            const targets = filters.length ? filters : [undefined];
            for (const filter of targets) {
              const launch = filter
                ? `pnpm ${quote(filter)} ${quote(task)}`
                : `turbo run ${quote(task)}`;
              inspect(`${launch} -- ${forwarded.map(quote).join(' ')}`, name, '.', [
                ...stack,
                path,
              ]);
            }
          }
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
        } else if (entry.kind === 'empty-unit-probe') {
          if (args.some((arg) => CONFIG_FLAG.test(arg))) {
            refuse(name, 'unsupported empty-unit probe configuration arguments');
            continue;
          }
          // The pinned probe copies this config without changing its setup.
          add(['--selectProjects', 'unit', '--runInBand'], 'services/asset-service');
        } else if (entry.kind !== 'non-jest' || args.some((arg) => CONFIG_FLAG.test(arg)))
          refuse(name, `unsupported registered launcher ${path}`);
        continue;
      }
      if (fileIndex >= 0 || shellOperand >= 0) continue;
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
    for (const nested of unread) inspect(nested.script, name, cwd, [...stack, 'substitution']);
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
