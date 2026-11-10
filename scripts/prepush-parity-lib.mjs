import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { scopeFromRoot } from './prepush-scope-lib.mjs';

const refuse = () => {
  throw new Error('Prepush parity: execution or CI coverage refused');
};
// A refusal about the pinned pnpm inputs. Its message names only fixed text and package.json
// keys (JSON-quoted), never a value, so the CLI may print it.
export class PnpmInputRefusal extends Error {
  name = 'PnpmInputRefusal';
}
const refuseInput = (reason) => {
  throw new PnpmInputRefusal(`Prepush parity: pnpm inputs refused: ${reason}`);
};
const load = (root, file) => readFileSync(`${root}/${file}`, 'utf8');

// Pin all workflow context and all quality-job values, not just key names.
// Repository pnpm inputs are pinned with normalized line endings; new settings require review.
// FU-111: the one `quality` job is five parallel `quality-*` jobs and an aggregate named
// `quality`. The manifest pins every one of them and their steps in this order; a quality job
// the manifest does not list, or one it lists that is gone, refuses (fail closed), so no step
// of the family can be added, moved or dropped without an explicit entry and reason.
export const QUALITY_JOBS = [
  'quality-guards',
  'quality-lint',
  'quality-types',
  'quality-unit',
  'quality-build',
  'quality',
];
const pnpmFiles = ['package.json', 'pnpm-workspace.yaml', '.npmrc'];
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// FU-093: root package.json is pinned by a projection, not by its whole-file digest, so a PR that
// adds or edits a script no quality job reaches does not invalidate every other PR's pin.
//
// The projection (PACKAGE_JSON_PROJECTION) is { fields, scripts }:
//   fields   every top-level key except `scripts`, verbatim (packageManager, engines, a future
//            `pnpm` key, dependencies, name, ...): an unknown key is pinned, never skipped;
//   scripts  the root scripts the quality-* jobs can run, derived (not listed by hand) from
//            (a) shell: every quality-* step's `run` and every reached script body is tokenized
//                (quotes, escapes and line continuations normalized; every simple command,
//                including those inside $(...) and `...`, is classified, see shellCommands);
//                `pnpm run <name>` reaches <name>, and every literal word of a modelled command
//                that names a root script (a turbo task, a launcher argument) is reached too;
//            (b) launchers (FU-093 r2): every source a modelled program runs or loads (a node
//                entry, `--import` file or `-e` code; turbo.json; the eslint/prettier config;
//                a `bash <file>`), and transitively every repository code file named by a path
//                in one, is scanned: a root script name it holds as a quoted literal, or after
//                `run`/`pnpm`, is reached (over-pinning costs only a rare repin);
//            plus the pre/post hook of each and the lifecycle scripts `pnpm install` runs.
// The pin is one `sha256:<hex>` per entry of the canonical JSON (recursively sorted keys, no
// whitespace) of its value, so independent edits touch independent pin lines. Fail closed: a
// referenced script that is missing, a command word built from an expansion, shell control
// flow, a wrapper (env, sh -c, xargs, ...), any program or pnpm form not modelled below, a
// node/bash file outside the repository or missing, a malformed package.json, or a whole-file
// pin (the pre-FU-093 form) refuses; nothing unmodelled is skipped.
// `node scripts/prepush-parity-repin.mjs` rewrites the pins with packageJsonPin() below.
export const PACKAGE_JSON_PROJECTION = 'root-scripts-reached-by-quality-jobs/v2';
const LIFECYCLE = [
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
];
// A script name, never an option: `-w` after `--filter` would run the root's own script.
const SCRIPT_NAME = /^[A-Za-z0-9:_][A-Za-z0-9:_-]*$/;
const WORKSPACE_PACKAGE = /^@rasta\/[a-z0-9-]+$/;
const WORKSPACE_DIR = /^(?:apps|packages|services|tests)\/[a-z0-9-]+$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Variables that change which program runs or what it loads (PATH lookup, Node/pnpm/npm/turbo
// options, shell startup): assigning one refuses, the projection could not follow it.
const RUN_CONTROL =
  /^(?:PATH|ENV|IFS|SHELL|SHELLOPTS|BASHOPTS|CDPATH|PS4|HOME|(?:NODE|NPM|PNPM|COREPACK|TURBO|BASH|LD|DYLD)_\w*|(?:npm|pnpm)_\w*)$/i;
const CODE_FILE = /\.(?:mjs|cjs|js|ts|mts|cts|sh|bash)$/;
// Words that make the next words control flow or a wrapped command: never modelled.
const RESERVED = new Set(
  'if then else elif fi case esac for while until do done select function coproc time { } ! [[ ]]'.split(
    ' ',
  ),
);
// Programs that run nothing they are given: their words are only checked for script names.
const INERT = new Set(['echo', 'printf', 'true', 'false', 'rimraf']);
// The repository files a modelled tool loads and executes by itself (missing ones are skipped).
const TOOL_SOURCES = {
  eslint: ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts'],
  prettier: [
    '.prettierrc.mjs',
    '.prettierrc.cjs',
    '.prettierrc.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
    'prettier.config.js',
  ],
};

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isMapping(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

// Tokenizes shell text the way bash reads it, as far as needed to name every command word:
// returns the simple commands as arrays of { text, expanded, assignment } words, those inside
// $(...) and `...` included. Quotes, backslash escapes and line continuations are removed from
// the text; `expanded` marks a word bash would build from a parameter, command or arithmetic
// expansion. Here-documents, process substitution, ANSI-C quoting, unbalanced quotes or
// parentheses refuse: their commands cannot be read without modelling more of the shell.
export function shellCommands(text, where) {
  const fail = (what) => refuseInput(`${where} ${what}`);
  // GitHub substitutes ${{ ... }} into the text before bash reads it: any text may result.
  if (text.includes('${{')) fail('uses a GitHub expression, which is not modelled');
  const commands = [];
  const scan = (start, closer) => {
    let i = start;
    let words = [];
    let word = null;
    let redirect = false;
    let depth = 0;
    const current = () =>
      (word ??= { text: '', expanded: false, quoted: false, assignment: false });
    const endWord = () => {
      if (word === null) return;
      // A target named by an expansion may be $GITHUB_ENV or $GITHUB_PATH: later steps would
      // run with another PATH or NODE_OPTIONS.
      if (redirect && word.expanded) fail('redirects to a file named by an expansion');
      if (redirect) redirect = false;
      else words.push(word);
      word = null;
    };
    const endCommand = () => {
      endWord();
      if (redirect) fail('has a redirection without a target');
      if (words.length > 0) commands.push(words);
      words = [];
    };
    const substitution = (from, end) => {
      current().expanded = true;
      return scan(from, end);
    };
    const dollar = () => {
      const next = text[i + 1];
      if (next === '(') {
        if (text[i + 2] === '(') fail('uses arithmetic expansion');
        i = substitution(i + 2, ')');
        return true;
      }
      if (next !== undefined && /[A-Za-z0-9_{@*#?$!-]/.test(next)) {
        current().expanded = true;
        current().text += '$';
        i += 1;
        return true;
      }
      return false;
    };
    while (i < text.length) {
      const c = text[i];
      if (c === closer && (closer === '`' || depth === 0)) {
        endCommand();
        return i + 1;
      }
      if (c === '\\') {
        if (text[i + 1] === '\n') i += 2;
        else if (i + 1 < text.length) {
          current().text += text[i + 1];
          word.quoted = true;
          i += 2;
        } else fail('ends with a backslash');
      } else if (c === "'") {
        const end = text.indexOf("'", i + 1);
        if (end < 0) fail('has an unterminated quote');
        current().text += text.slice(i + 1, end);
        word.quoted = true;
        i = end + 1;
      } else if (c === '"') {
        current().quoted = true;
        i += 1;
        for (;;) {
          if (i >= text.length) fail('has an unterminated quote');
          const d = text[i];
          if (d === '"') break;
          if (d === '\\' && /[$`"\\\n]/.test(text[i + 1] ?? '')) {
            if (text[i + 1] !== '\n') word.text += text[i + 1];
            i += 2;
          } else if (d === '`') {
            i = substitution(i + 1, '`');
          } else if (d === '$' && dollar()) {
            // dollar() consumed the expansion.
          } else {
            word.text += d;
            i += 1;
          }
        }
        i += 1;
      } else if (c === '$' && (text[i + 1] === "'" || text[i + 1] === '"')) {
        fail('uses ANSI-C or locale quoting');
      } else if (c === '$' && dollar()) {
        // dollar() consumed the expansion.
      } else if (c === '`') {
        i = substitution(i + 1, '`');
      } else if (c === '#' && word === null) {
        while (i < text.length && text[i] !== '\n') i += 1;
      } else if (c === ' ' || c === '\t' || c === '\r') {
        endWord();
        i += 1;
      } else if (c === '<' || c === '>' || (c === '&' && text[i + 1] === '>')) {
        if (text[i + 1] === '(') fail('uses process substitution');
        if (c === '<' && text[i + 1] === '<') fail('uses a here-document or here-string');
        if (word !== null && !word.quoted && !word.expanded && /^\d+$/.test(word.text)) word = null;
        endWord();
        i += 1;
        while (/[<>&|]/.test(text[i] ?? '')) i += 1;
        redirect = true;
      } else if (c === '\n' || c === ';' || c === '&' || c === '|') {
        endCommand();
        i += 1;
      } else if (c === '(') {
        if (word !== null) fail('has a parenthesis inside a word');
        endCommand();
        depth += 1;
        i += 1;
      } else if (c === ')') {
        if (depth === 0) fail('has an unbalanced parenthesis');
        endCommand();
        depth -= 1;
        i += 1;
      } else {
        if (
          c === '=' &&
          word !== null &&
          !word.quoted &&
          !word.expanded &&
          ASSIGNMENT.test(word.text) &&
          words.every((w) => w.assignment)
        )
          word.assignment = true;
        current().text += c;
        i += 1;
      }
    }
    if (closer !== undefined || depth > 0) fail('has an unterminated substitution or group');
    endCommand();
    return i;
  };
  scan(0, undefined);
  return commands;
}

// What one shell text runs: { scripts: [name, required][], sources: [path, required][],
// inline: string[], mentions: string[] }. Every simple command is classified; a form not
// modelled here refuses (fail closed). Messages name no command text: it is a package.json value.
function shellRuns(text, where, rootName) {
  const fail = (what) => refuseInput(`${where} ${what}`);
  const out = {
    scripts: [],
    sources: [],
    inline: [],
    mentions: [],
    turbo: false,
    workspaces: false,
  };
  for (const command of shellCommands(text, where)) {
    for (const word of command)
      if (word.assignment && RUN_CONTROL.test(word.text.slice(0, word.text.indexOf('='))))
        fail('assigns a variable that changes what runs, which is not modelled');
    const words = command.filter((word) => !word.assignment);
    if (words.length === 0) continue;
    const [program, ...args] = words;
    if (program.expanded) fail('runs a command word built from an expansion');
    if (RESERVED.has(program.text)) fail('uses shell control flow, which is not modelled');
    for (const word of words) if (!word.expanded) out.mentions.push(word.text);
    const literal = args.map((word) => word.text);
    const expandedArg = args.findIndex((word) => word.expanded);
    if (program.text === 'pnpm') {
      if (expandedArg >= 0)
        fail('runs a package manager command whose root scripts cannot be named (expanded)');
      if (literal.length === 2 && literal[0] === 'install' && literal[1] === '--frozen-lockfile')
        out.scripts.push(...LIFECYCLE.map((name) => [name, false]));
      else if (literal.length === 2 && literal[0] === 'run' && SCRIPT_NAME.test(literal[1]))
        out.scripts.push([literal[1], true]);
      // Another workspace's own script (FU-093 r2: only through `run`; never exec, dlx, ...).
      else if (!(
        literal.length === 4 &&
        literal[2] === 'run' &&
        SCRIPT_NAME.test(literal[3]) &&
        ((literal[0] === '--filter' &&
          WORKSPACE_PACKAGE.test(literal[1]) &&
          literal[1] !== rootName) ||
          (literal[0] === '--dir' && WORKSPACE_DIR.test(literal[1])))
      ))
        fail('runs a package manager command whose root scripts cannot be named');
      else if (literal[0] === '--filter' || literal[0] === '--dir') out.workspaces = true;
    } else if (program.text === 'node') {
      let entry = false;
      let test = false;
      for (const [index, word] of args.entries()) {
        if (word.expanded && !(entry && !test))
          fail('runs node with an expanded program or option');
        if (word.expanded) continue;
        const value = word.text;
        if (/^(?:-e|-p|--eval|--print)$/.test(value)) {
          if (index + 1 >= args.length || args[index + 1].expanded)
            fail('runs node code that cannot be read');
          out.inline.push(args[index + 1].text);
          entry = true;
          break;
        }
        if (value === '--test') test = true;
        else if (/^-/.test(value)) {
          // An option value that names a file: a module it loads (--import, --require,
          // --test-reporter, ...) or an env file, which can set NODE_OPTIONS.
          const file = value.includes('=') ? value.slice(value.indexOf('=') + 1) : '';
          if (CODE_FILE.test(file)) out.sources.push([file, true]);
          else if (/^--env-file/.test(value)) out.sources.push([file, false]);
        } else if (test || !entry || CODE_FILE.test(value)) {
          out.sources.push([value, test || !entry]);
          entry = true;
        }
      }
      if (!entry) fail('runs node without a program file');
    } else if (program.text === 'bash') {
      if (args.length === 0 || args[0].expanded || args[0].text.startsWith('-'))
        fail('runs bash without a program file');
      out.sources.push([args[0].text, true]);
    } else if (program.text === 'turbo') {
      // Workspace tasks, and a root script only as a `//#<task>` task of turbo.json.
      if (expandedArg >= 0) fail('runs turbo with an expanded task');
      out.turbo = true;
      out.workspaces = true;
    } else if (Object.hasOwn(TOOL_SOURCES, program.text)) {
      out.sources.push(...TOOL_SOURCES[program.text].map((file) => [file, false]));
    } else if (
      program.text === 'docker' &&
      literal[0] === 'compose' &&
      ['down', 'logs', 'exec'].includes(literal[1]) &&
      expandedArg < 0
    ) {
      // Stops, tails or runs a command inside an existing container, never the host's pnpm; the
      // compose file (what the containers mount and run) is a launcher source.
      out.sources.push(...COMPOSE_FILES.map((file) => [file, false]));
    } else if (!INERT.has(program.text)) fail('runs a program the projection does not model');
  }
  return out;
}

// Literal facts in a launcher source: root script names it holds as a quoted literal or after
// `run`/`pnpm` (a shell string inside code), and every repository code path it names, relative
// to its directory and to the root. Shell sources are scanned word by word. Memoized per file
// and text: the check computes the projection several times over the same sources.
const factsCache = new Map();
function launcherFacts(text, file, scripts) {
  let facts = factsCache.get(file);
  if (facts?.text !== text) {
    const words = new Set();
    const shellFile = /\.(?:sh|bash)$/.test(file);
    const literal = shellFile ? /([A-Za-z0-9:_-]+)/g : /['"`]([A-Za-z0-9:_-]+)(?=['"`])/g;
    for (const match of text.matchAll(literal)) words.add(match[1]);
    // A lookahead, so `pnpm run <name>` yields both `run` and <name>.
    for (const match of text.matchAll(/\b(?:run|pnpm)\s+(?=(?:-\S+\s+)*([A-Za-z0-9:_-]+))/g))
      words.add(match[1]);
    const paths = new Set();
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    for (const [found] of text.matchAll(/[\w.@/-]+/g)) {
      if (!CODE_FILE.test(found)) continue;
      const path = found.replace(/^\/+/, '');
      for (const candidate of [joinPath(dir, path), joinPath('', path)])
        if (candidate !== undefined) paths.add(candidate);
    }
    facts = { text, words: [...words], paths: [...paths] };
    factsCache.set(file, facts);
  }
  return { names: facts.words.filter((name) => Object.hasOwn(scripts, name)), paths: facts.paths };
}

// A repository-relative path, or undefined when it leaves the repository.
function joinPath(dir, path) {
  if (path.startsWith('/')) return undefined;
  const parts = [];
  for (const part of `${dir}/${path}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

// Memoized on the last workflow text: parsing it is most of the cost of one projection.
let lastRuns;
export function qualityRuns(workflow) {
  if (lastRuns?.workflow !== workflow) lastRuns = { workflow, runs: readRuns(workflow) };
  return lastRuns.runs.map((run) => ({ ...run }));
}

function readRuns(workflow) {
  const parsed = parse(workflow) ?? {};
  const { jobs } = parsed;
  if (!isMapping(jobs)) refuseInput('the CI workflow has no jobs');
  // Another shell, or defaults that change it, would make the run text mean something else.
  if (parsed.defaults !== undefined) refuseInput('the CI workflow sets defaults, not modelled');
  const runs = [];
  for (const id of QUALITY_JOBS) {
    if (!isMapping(jobs[id]) || !Array.isArray(jobs[id].steps))
      refuseInput(`CI job ${JSON.stringify(id)} has no steps`);
    if (jobs[id].defaults !== undefined)
      refuseInput(`CI job ${JSON.stringify(id)} sets defaults, not modelled`);
    for (const step of jobs[id].steps) {
      if (!isMapping(step)) refuseInput(`CI job ${JSON.stringify(id)} has a malformed step`);
      if (step.run === undefined) continue;
      if (typeof step.run !== 'string')
        refuseInput(`CI job ${JSON.stringify(id)} has a malformed run`);
      if (step.shell !== undefined && step.shell !== 'bash')
        refuseInput(`CI job ${JSON.stringify(id)} runs a step in a shell other than bash`);
      runs.push({ where: `CI job ${JSON.stringify(id)}`, text: step.run });
    }
  }
  return runs;
}

// readSource(path) returns a repository file's text, or null when there is no such file.
export function packageJsonProjection(text, runs, readSource) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    refuseInput('package.json is not valid JSON');
  }
  if (!isMapping(manifest) || !isMapping(manifest.scripts))
    refuseInput('package.json has no scripts mapping');
  const { scripts, ...fields } = manifest;
  if (Object.values(scripts).some((body) => typeof body !== 'string'))
    refuseInput('package.json has a script that is not a string');
  const reached = new Map();
  const scanned = new Map(); // repository file -> it exists
  let turboRead = false;
  let workspacesRead = false;
  const visit = ([name, required], where) => {
    if (reached.has(name)) return;
    if (!Object.hasOwn(scripts, name)) {
      if (required) refuseInput(`${where} runs script ${JSON.stringify(name)}, which is missing`);
      return;
    }
    reached.set(name, scripts[name]);
    for (const hook of [`pre${name}`, `post${name}`]) visit([hook, false], where);
    const inner = `script ${JSON.stringify(name)}`;
    take(shellRuns(scripts[name], inner, manifest.name), inner);
  };
  const scan = (source, file) => {
    const facts = launcherFacts(source, file, scripts);
    for (const name of facts.names) visit([name, false], 'a launcher');
    for (const path of facts.paths) if (CODE_FILE.test(path)) load(path, false, 'a launcher');
  };
  const load = (path, required, where) => {
    const file = joinPath('', path);
    if (file === undefined) refuseInput(`${where} runs a file outside the repository`);
    if (!scanned.has(file)) {
      const source = readSource(file);
      scanned.set(file, typeof source === 'string');
      if (typeof source === 'string') scan(source, file);
    }
    // Checked on every load: a path first named in passing may be run later.
    if (required && !scanned.get(file))
      refuseInput(`${where} runs a file that is not in the repository`);
  };
  const take = (run, where) => {
    for (const next of run.scripts) visit(next, where);
    for (const word of run.mentions) if (Object.hasOwn(scripts, word)) visit([word, false], where);
    for (const [path, required] of run.sources) load(path, required, where);
    for (const code of run.inline) scan(code, '');
    // Workspace scripts are launchers too (`pnpm -w run <name>`, `cd ../.. && pnpm <name>`):
    // every importer's package.json in the lockfile is scanned like any launcher source.
    if (run.workspaces && !workspacesRead) {
      workspacesRead = true;
      const lock = readSource('pnpm-lock.yaml');
      const importers = typeof lock === 'string' ? lock.split(/^importers:$/m)[1] : undefined;
      const dirs = [...(importers?.split(/^\S/m)[0] ?? '').matchAll(/^ {2}(\S+):$/gm)];
      if (dirs.length === 0)
        refuseInput(`${where} runs workspace scripts the lockfile does not list`);
      for (const [, dir] of dirs)
        if (dir !== '.') load(`${dir}/package.json`, false, 'a workspace');
    }
    if (run.turbo && !turboRead) {
      turboRead = true;
      const config = readSource('turbo.json');
      if (typeof config !== 'string') refuseInput(`${where} runs turbo without a turbo.json`);
      for (const [, name] of config.matchAll(/\/\/#([A-Za-z0-9:_-]+)/g))
        visit([name, true], 'turbo.json');
    }
  };
  for (const { where, text: run } of runs) take(shellRuns(run, where, manifest.name), where);
  for (const name of LIFECYCLE) visit([name, false], 'pnpm install');
  return { fields, scripts: Object.fromEntries(reached) };
}

const digestEach = (values) =>
  Object.fromEntries(
    Object.keys(values)
      .sort()
      .map((key) => [key, `sha256:${sha256(canonicalJson(values[key]))}`]),
  );

export function packageJsonPin(text, runs, readSource) {
  const { fields, scripts } = packageJsonProjection(text, runs, readSource);
  return {
    projection: PACKAGE_JSON_PROJECTION,
    fields: digestEach(fields),
    scripts: digestEach(scripts),
  };
}

// The pnpm inputs as read from a repository: the three files, plus `sources`, every launcher
// file the projection read (text, or null when absent), so the check and the post-execution
// re-read see exactly the same files. read(file) throws when the file cannot be read.
export function collectPnpmInputs(workflow, read) {
  const inputs = Object.fromEntries(pnpmFiles.map((file) => [file, read(file)]));
  const sources = {};
  const readSource = (file) => {
    if (!Object.hasOwn(sources, file)) {
      try {
        sources[file] = read(file);
      } catch (error) {
        if (!['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error?.code)) throw error;
        sources[file] = null;
      }
    }
    return sources[file];
  };
  packageJsonProjection(inputs['package.json'], qualityRuns(workflow), readSource);
  return { ...inputs, sources };
}

// The pins the manifest must hold for these inputs; shared by the check and the repin helper.
export function pnpmInputPins(workflow, pnpmInputs) {
  const { sources } = pnpmInputs ?? {};
  if (!isMapping(sources)) refuseInput('the launcher sources were not collected');
  const readSource = (file) => {
    const source = Object.hasOwn(sources, file) ? sources[file] : undefined;
    if (source !== null && typeof source !== 'string')
      refuseInput('a launcher source was not collected');
    return source;
  };
  const pins = {};
  for (const file of pnpmFiles) {
    if (typeof pnpmInputs?.[file] !== 'string') refuseInput(`${file} is missing`);
    pins[file] =
      file === 'package.json'
        ? packageJsonPin(pnpmInputs[file], qualityRuns(workflow), readSource)
        : sha256(pnpmInputs[file].replace(/\r\n?/g, '\n'));
  }
  return pins;
}

function checkPnpmInputs(workflow, pinned, pnpmInputs) {
  const actual = pnpmInputPins(workflow, pnpmInputs);
  if (!isMapping(pinned)) refuseInput('the manifest has no pnpmInputs mapping');
  const pin = pinned['package.json'];
  if (typeof pin === 'string')
    refuseInput(
      'package.json is pinned by a whole-file digest, which is no longer accepted (FU-093); repin with node scripts/prepush-parity-repin.mjs',
    );
  if (!isMapping(pin) || pin.projection !== PACKAGE_JSON_PROJECTION)
    refuseInput(`package.json pin is not the ${PACKAGE_JSON_PROJECTION} projection`);
  if (isDeepStrictEqual(actual, pinned)) return;
  const changed = [];
  for (const file of new Set([...Object.keys(actual), ...Object.keys(pinned)])) {
    if (file !== 'package.json') {
      if (actual[file] !== pinned[file]) changed.push(JSON.stringify(file));
      continue;
    }
    for (const part of ['fields', 'scripts']) {
      const now = actual[file][part];
      const was = isMapping(pin[part]) ? pin[part] : {};
      for (const key of new Set([...Object.keys(now), ...Object.keys(was)]))
        if (now[key] !== was[key]) changed.push(`package.json ${part} ${JSON.stringify(key)}`);
    }
    if (Object.keys(pin).some((key) => !['projection', 'fields', 'scripts'].includes(key)))
      changed.push('package.json pin keys');
  }
  refuseInput(
    `changed since the reviewed pin: ${changed.join(', ')}; review, then repin with node scripts/prepush-parity-repin.mjs`,
  );
}
export function validateParity(workflow, manifest, scripts, pnpmInputs) {
  const { jobs, ...context } = parse(workflow);
  if (manifest?.version !== 3) refuse();
  if (!isDeepStrictEqual(context, manifest.workflow)) refuse();
  if (!isMapping(jobs) || !isMapping(manifest.jobs)) refuse();
  const family = Object.keys(jobs).filter((id) => id === 'quality' || id.startsWith('quality-'));
  if (!isDeepStrictEqual([...family].sort(), [...QUALITY_JOBS].sort())) refuse();
  if (!isDeepStrictEqual(Object.keys(manifest.jobs), QUALITY_JOBS)) refuse();
  const steps = [];
  for (const id of QUALITY_JOBS) {
    if (!isMapping(jobs[id]) || !Array.isArray(jobs[id].steps)) refuse();
    const { steps: jobSteps, ...job } = jobs[id];
    if (!isDeepStrictEqual(job, manifest.jobs[id])) refuse();
    steps.push(...jobSteps.map((step) => ({ id, step })));
  }
  if (!Array.isArray(manifest.steps)) refuse();
  if (steps.length !== manifest.steps.length) refuse();
  checkPnpmInputs(workflow, manifest.pnpmInputs, pnpmInputs);
  const checks = [];
  for (const [index, { id, step }] of steps.entries()) {
    const entry = manifest.steps[index];
    if (entry?.job !== id) refuse();
    if (!isDeepStrictEqual(step, entry.ci)) refuse();
    if (entry.script !== undefined) {
      if (
        entry.reason !== undefined ||
        !isDeepStrictEqual(Object.keys(step).sort(), ['name', 'run']) ||
        step.run !== `pnpm run ${entry.script}` ||
        ['pre', 'post'].some((prefix) => scripts[`${prefix}${entry.script}`] !== undefined) ||
        scripts[entry.script] !== entry.command ||
        entry.command !==
          `node --test --test-timeout=300000 scripts/${entry.script.slice(5)}.test.mjs`
      )
        refuse();
      checks.push(entry);
    } else if (!entry.reason?.trim()) refuse();
  }
  if (
    !isDeepStrictEqual(
      checks.map((c) => c.script),
      ['test:prepush-scope', 'test:prepush-parity'],
    )
  )
    refuse();
  return checks;
}

export function controlledEnv(base) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) refuse();
  const env = {
    NODE_ENV: 'test',
    CI: 'true',
    TURBO_TELEMETRY_DISABLED: '1',
    SERVICE_ENV_WITHHELD_BASE: base,
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function executeCheck(root, entry, env) {
  // The audited direct Node command avoids package-manager hooks and shell
  // startup files. Neither inherited NODE_OPTIONS nor root .env is loaded.
  execFileSync(process.execPath, entry.command.split(' ').slice(1), {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Inputs are root + base only. A previously printed selection is never accepted.
export function runParity(
  root,
  base,
  {
    select = scopeFromRoot,
    execute: runCheck = executeCheck,
    read = load,
    report = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const scope = select(root, base);
  const env = controlledEnv(scope.resolvedBase);
  const inputs = () => {
    const workflow = read(root, '.github/workflows/ci.yml');
    return [
      workflow,
      JSON.parse(read(root, 'scripts/prepush-parity.json')),
      JSON.parse(read(root, 'package.json')).scripts,
      collectPnpmInputs(workflow, (file) => read(root, file)),
    ];
  };
  const before = inputs();
  const checks = validateParity(...before);
  const receipts = [];
  for (const entry of checks) {
    report(`CI quality / ${entry.ci.name ?? entry.script}: ${entry.script}`);
    const expected = { script: entry.script, command: entry.command, env: { ...env } };
    runCheck(root, entry, { ...env });
    receipts.push(expected); // Only after successful synchronous execution.
  }
  const after = inputs();
  if (!isDeepStrictEqual(before, after)) refuse();
  const finalScope = select(root, scope.resolvedBase);
  if (!isDeepStrictEqual(scope, finalScope)) refuse();
  const exclusions = before[1].steps.filter((entry) => entry.reason);
  for (const entry of exclusions)
    report(`EXCLUDED ${entry.ci.name ?? entry.ci.run ?? entry.ci.uses}: ${entry.reason}`);
  report(
    `Parity slice only: ${receipts.length} checks passed; ${exclusions.length} explicit exclusions. Full prepush gate remains incomplete.`,
  );
  return { scope, receipts, exclusions };
}
