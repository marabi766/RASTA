/**
 * Static contract for the ADR-055 fresh-run campaign workflow **draft**.
 *
 * The preregistered campaign (`docs/evidence/adr-055/fresh-run-first-pair-
 * replication-design-2026-09-16.md` §§ 4, 7, 8.3, 9) forbids any retry, rerun,
 * replacement or optional stopping of its 59 one-pair slots. That is a property
 * of the workflow, not of the harness, so it is checked here on the reviewed,
 * non-executable draft before any launch iteration installs it.
 *
 * Pure: text in, `{ ok, problems }` out. No file system, no network, no GitHub.
 *
 * **Not a YAML parser.** `parseWorkflowDraft` accepts only the narrow block
 * subset the draft uses — space-indented block mappings and sequences,
 * single-line flow sequences of simple scalars, plain / single- / double-quoted
 * scalars, and `|`, `|-`, `>`, `>-` block scalars. Anything else
 * (tabs, CR, anchors, aliases, tags, flow mappings, merge keys, multiple
 * documents, a duplicate key in any mapping, a null value) is refused rather
 * than guessed at, so a construct GitHub might read differently can never pass.
 *
 * **What this cannot prove.** A static check shows the shape of the proposed
 * workflow and that a manual re-run attempt refuses before checkout. It cannot
 * show that GitHub never retries hosted-runner infrastructure internally, and
 * it cannot show that an uninstalled draft governed any actual run.
 */

export const CAMPAIGN_SLOT_COUNT = 59;
export const CAMPAIGN_RUNNER = 'ubuntu-24.04';
export const CAMPAIGN_JOB_TIMEOUT_MINUTES = '45';
export const CAMPAIGN_SERVICE_IMAGE = 'postgis/postgis:16-3.4';
export const MAX_DRAFT_BYTES = 256 * 1024;
export const MAX_REPORTED_PROBLEMS = 25;

const FULL_SHA_ACTION =
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*@[0-9a-f]{40}$/;
const KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?: +(.*))?$/;
const FLOW_ITEM = /^[A-Za-z0-9_./@+-]+$/;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const MATRIX_SLOT = '${{ matrix.slot }}';
const SLOT_NAME = /^[A-Za-z0-9._-]*\$\{\{ matrix\.slot \}\}[A-Za-z0-9._-]*$/;
const PRINTABLE_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

const TOP_LEVEL_KEYS = new Set(['name', 'on', 'concurrency', 'permissions', 'env', 'jobs']);
const JOB_KEYS = new Set(['name', 'runs-on', 'timeout-minutes', 'strategy', 'services', 'steps']);
const STEP_KEYS = new Set(['name', 'run', 'uses', 'with', 'env', 'if']);
const UPLOAD_WITH_KEYS = new Set(['name', 'path', 'retention-days', 'if-no-files-found']);

/** Retry, rerun, re-dispatch and replacement spellings in executable values. */
const RETRY_SPELLING =
  /retr(?:y|ies)|re-?runs?|re-?try|re-?dispatch|resubmi|replac|workflow_dispatch|repository_dispatch|max[_-]?attempts|run_attempt|\bgh\b/i;
const LOOP_KEYWORD = /(?:^|[\s;&|(])(?:for|while|until)(?=\s)/;
const TOKEN_REFERENCE = /secrets|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN/i;
/** Docker's container health-check option is not a job retry. */
const HEALTH_RETRIES = /--health-retries \d+/g;

const MEASUREMENT_BODY = [
  'set +e',
  null, // the invocation, checked token by token
  'status=$?',
  'set -e',
  'echo "campaign_exit=$status"',
  'exit "$status"',
];

// ---------------------------------------------------------------------------
// Narrow parser

class DraftSyntaxError extends Error {
  constructor(line, reason) {
    super(reason);
    this.line = line;
  }
}

function fail(line, reason) {
  throw new DraftSyntaxError(line, reason);
}

function indentOf(raw) {
  return raw.length - raw.trimStart().length;
}

function isInsignificant(raw) {
  const content = raw.trim();
  return content === '' || content.startsWith('#');
}

/** Cuts a trailing ` # comment` from a plain or quoted remainder. */
function onlyComment(rest, line) {
  const trimmed = rest.trim();
  if (trimmed !== '' && !trimmed.startsWith('#'))
    fail(line, 'unexpected text after a quoted value');
}

function parseInlineScalar(text, line) {
  const first = text[0];
  if (first === "'") {
    let value = '';
    let index = 1;
    for (;;) {
      if (index >= text.length) fail(line, 'unterminated single-quoted value');
      if (text[index] === "'") {
        if (text[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        break;
      }
      value += text[index];
      index += 1;
    }
    onlyComment(text.slice(index + 1), line);
    return { kind: 'scalar', style: 'single', value, line };
  }
  if (first === '"') {
    const close = text.indexOf('"', 1);
    if (close < 0) fail(line, 'unterminated double-quoted value');
    const value = text.slice(1, close);
    if (value.includes('\\')) fail(line, 'escape sequences are not supported');
    onlyComment(text.slice(close + 1), line);
    return { kind: 'scalar', style: 'double', value, line };
  }
  if (first === '[') {
    const close = text.indexOf(']');
    if (close < 0) fail(line, 'unterminated flow sequence');
    onlyComment(text.slice(close + 1), line);
    const inner = text.slice(1, close).trim();
    if (inner.includes('[') || inner.includes('{'))
      fail(line, 'nested flow collections are not supported');
    const items =
      inner === ''
        ? []
        : inner.split(',').map((part) => {
            const value = part.trim();
            if (!FLOW_ITEM.test(value)) fail(line, 'unsupported flow sequence item');
            return { kind: 'scalar', style: 'plain', value, line };
          });
    return { kind: 'seq', flow: true, items, line };
  }
  if ('{&*!|>%@`?-,]}#'.includes(first)) fail(line, 'unsupported value syntax');

  const commentAt = text.search(/\s#/);
  const value = (commentAt < 0 ? text : text.slice(0, commentAt)).trimEnd();
  if (value === '') fail(line, 'empty value');
  if (value.includes(': ') || value.endsWith(':')) fail(line, 'ambiguous plain value');
  return { kind: 'scalar', style: 'plain', value, line };
}

class Parser {
  constructor(text) {
    if (text.charCodeAt(0) === 0xfeff) fail(1, 'byte-order mark is not supported');
    if (text.includes('\r')) fail(1, 'carriage returns are not supported');
    this.lines = text.split('\n');
    if (this.lines.at(-1) === '') this.lines.pop();
    this.lines.forEach((raw, index) => {
      if (raw.includes('\t')) fail(index + 1, 'tab characters are not supported');
      if (/^(?:---|\.\.\.)(?:\s|$)/.test(raw) || raw.startsWith('%'))
        fail(index + 1, 'document markers and directives are not supported');
    });
    this.index = 0;
  }

  skipInsignificant() {
    while (this.index < this.lines.length && isInsignificant(this.lines[this.index]))
      this.index += 1;
  }

  peek() {
    this.skipInsignificant();
    return this.index < this.lines.length ? this.lines[this.index] : null;
  }

  parseDocument() {
    const first = this.peek();
    if (first === null) fail(1, 'empty draft');
    if (indentOf(first) !== 0) fail(this.index + 1, 'the document must start at column 0');
    const root = this.parseMap(0);
    if (this.peek() !== null) fail(this.index + 1, 'unexpected indentation');
    return root;
  }

  parseBlock(indent) {
    const raw = this.peek();
    const content = raw.trimStart();
    return content === '-' || content.startsWith('- ')
      ? this.parseSeq(indent)
      : this.parseMap(indent);
  }

  parseMap(indent) {
    const node = { kind: 'map', entries: new Map(), line: this.index + 1 };
    for (;;) {
      const raw = this.peek();
      if (raw === null || indentOf(raw) < indent) return node;
      const line = this.index + 1;
      if (indentOf(raw) > indent) fail(line, 'unexpected indentation');
      const content = raw.slice(indent);
      if (content === '-' || content.startsWith('- ')) return node;
      const match = KEY.exec(content);
      if (!match) fail(line, 'expected a simple key');
      const key = match[1];
      if (node.entries.has(key)) {
        fail(line, `duplicate key ${PRINTABLE_KEY.test(key) ? JSON.stringify(key) : ''}`.trimEnd());
      }
      this.index += 1;
      const rest = (match[2] ?? '').trim();
      node.entries.set(key, { keyLine: line, value: this.parseValue(rest, indent, line) });
    }
  }

  parseValue(rest, indent, line) {
    if (rest === '' || rest.startsWith('#')) {
      const next = this.peek();
      if (next === null || indentOf(next) <= indent) fail(line, 'empty value');
      return this.parseBlock(indentOf(next));
    }
    if (/^[|>]-?$/.test(rest)) return this.parseBlockScalar(rest, indent, line);
    if (/^[|>]/.test(rest)) fail(line, 'unsupported block scalar header');
    return parseInlineScalar(rest, line);
  }

  parseBlockScalar(header, indent, line) {
    const collected = [];
    let contentIndent = null;
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index];
      if (raw.trim() === '') {
        collected.push('');
        this.index += 1;
        continue;
      }
      const lineIndent = indentOf(raw);
      if (contentIndent === null) {
        if (lineIndent <= indent) break;
        contentIndent = lineIndent;
      }
      if (lineIndent < contentIndent) break;
      collected.push(raw.slice(contentIndent));
      this.index += 1;
    }
    // Trailing blank lines belong to no one; give them back.
    while (collected.length > 0 && collected.at(-1) === '') {
      collected.pop();
      this.index -= 1;
    }
    if (contentIndent === null || collected.length === 0) fail(line, 'empty block scalar');
    const literal = header.startsWith('|');
    const value = literal
      ? collected.join('\n') + (header.endsWith('-') ? '' : '\n')
      : collected.join(' ').replace(/ {2,}/g, ' ');
    return { kind: 'scalar', style: literal ? 'literal' : 'folded', value, line };
  }

  parseSeq(indent) {
    const node = { kind: 'seq', flow: false, items: [], line: this.index + 1 };
    for (;;) {
      const raw = this.peek();
      if (raw === null || indentOf(raw) < indent) return node;
      const line = this.index + 1;
      if (indentOf(raw) > indent) fail(line, 'unexpected indentation');
      const content = raw.slice(indent);
      if (!(content === '-' || content.startsWith('- '))) fail(line, 'expected a sequence item');
      const rest = content.slice(1).trimStart();
      if (rest === '' || rest.startsWith('#')) {
        this.index += 1;
        const next = this.peek();
        if (next === null || indentOf(next) <= indent) fail(line, 'empty sequence item');
        node.items.push(this.parseBlock(indentOf(next)));
      } else if (KEY.test(rest)) {
        // `- key: value` opens a mapping whose keys sit two columns in.
        const itemIndent = indent + (content.length - rest.length);
        this.lines[this.index] = ' '.repeat(itemIndent) + rest;
        node.items.push(this.parseMap(itemIndent));
      } else {
        this.index += 1;
        node.items.push(parseInlineScalar(rest, line));
      }
    }
  }
}

/**
 * Parses the fixed draft subset. Returns `{ ok: true, root }` or
 * `{ ok: false, line, reason }` — never a partial tree.
 */
export function parseWorkflowDraft(text) {
  if (typeof text !== 'string') return { ok: false, line: 0, reason: 'draft is not text' };
  try {
    return { ok: true, root: new Parser(text).parseDocument() };
  } catch (error) {
    if (error instanceof DraftSyntaxError)
      return { ok: false, line: error.line, reason: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Semantic contract

function isScalar(node, style) {
  return node?.kind === 'scalar' && (style === undefined || node.style === style);
}

function plainEquals(node, value) {
  return isScalar(node, 'plain') && node.value === value;
}

function entry(map, key) {
  return map?.kind === 'map' ? map.entries.get(key)?.value : undefined;
}

function keyName(key) {
  return PRINTABLE_KEY.test(key) ? JSON.stringify(key) : 'an unprintable key';
}

function* walk(node, path = []) {
  yield { node, path };
  if (node?.kind === 'map') {
    for (const [key, { value }] of node.entries) yield* walk(value, [...path, key]);
  } else if (node?.kind === 'seq') {
    for (const [index, item] of node.items.entries()) yield* walk(item, [...path, index]);
  }
}

function tokenizeShellLine(line) {
  return line.match(/"[^"]*"|\S+/g) ?? [];
}

function checkMatrix(strategy, problems) {
  if (strategy?.kind !== 'map') {
    problems.push('job strategy must be a mapping with fail-fast and matrix');
    return;
  }
  for (const key of strategy.entries.keys()) {
    if (key !== 'fail-fast' && key !== 'matrix')
      problems.push(`strategy key ${keyName(key)} is not allowed`);
  }
  if (!plainEquals(entry(strategy, 'fail-fast'), 'false')) {
    problems.push('strategy.fail-fast must be exactly false');
  }
  const matrix = entry(strategy, 'matrix');
  if (matrix?.kind !== 'map') {
    problems.push('strategy.matrix must be a literal mapping (no dynamic matrix)');
    return;
  }
  for (const key of matrix.entries.keys()) {
    if (key !== 'slot')
      problems.push(`matrix axis ${keyName(key)} is not allowed; slot is the only axis`);
  }
  const slots = entry(matrix, 'slot');
  if (slots?.kind !== 'seq') {
    problems.push('matrix.slot must be a literal sequence (no dynamic matrix)');
    return;
  }
  const seen = new Set();
  for (const item of slots.items) {
    if (!isScalar(item, 'plain') || !/^[1-9]\d*$/.test(item.value)) {
      problems.push(`line ${item.line}: matrix.slot entries must be unquoted integers`);
      continue;
    }
    const slot = Number(item.value);
    if (slot > CAMPAIGN_SLOT_COUNT) {
      problems.push(
        `line ${item.line}: matrix.slot entry is out of range 1..${CAMPAIGN_SLOT_COUNT}`,
      );
    } else if (seen.has(slot)) {
      problems.push(`line ${item.line}: matrix.slot entry ${slot} is repeated`);
    }
    seen.add(slot);
  }
  if (slots.items.length !== CAMPAIGN_SLOT_COUNT) {
    problems.push(
      `matrix.slot has ${slots.items.length} entries; exactly ${CAMPAIGN_SLOT_COUNT} are required`,
    );
  }
  for (let slot = 1; slot <= CAMPAIGN_SLOT_COUNT; slot += 1) {
    if (!seen.has(slot)) problems.push(`matrix.slot is missing slot ${slot}`);
  }
}

function checkGuard(step, problems) {
  const where = 'the first step';
  if (step?.kind !== 'map') {
    problems.push(`${where} does not effectively refuse github.run_attempt other than 1 (no step)`);
    return false;
  }
  for (const key of step.entries.keys()) {
    if (key !== 'name' && key !== 'run') {
      problems.push(`${where} (run_attempt guard) must have no ${keyName(key)}`);
    }
  }
  const run = entry(step, 'run');
  if (!isScalar(run) || typeof run.value !== 'string') {
    problems.push(
      `${where} does not effectively refuse github.run_attempt other than 1 (not a run step)`,
    );
    return false;
  }
  const lines = run.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const attempt = '"${{ github.run_attempt }}"';
  const exit = /^exit [1-9]\d*$/;
  const echo = /^echo '[^'$`]*' >&2$/;
  const ifForm =
    lines.length >= 3 &&
    lines[0] === `if [ ${attempt} != "1" ]; then` &&
    exit.test(lines.at(-2)) &&
    lines.at(-1) === 'fi' &&
    lines.slice(1, -2).every((line) => echo.test(line));
  const orForm =
    lines.length === 1 &&
    (lines[0] === `[ ${attempt} = "1" ] || exit 1` ||
      lines[0] === `test ${attempt} = "1" || exit 1`);
  if (!ifForm && !orForm) {
    problems.push(
      `${where} does not effectively refuse github.run_attempt other than 1 (exit non-zero before checkout)`,
    );
    return false;
  }
  return true;
}

function checkInvocation(line, problems) {
  const tokens = tokenizeShellLine(line);
  const expectPrefix = ['pnpm', 'run', 'calibrate:aggregation-stress', '--'];
  if (expectPrefix.some((token, index) => tokens[index] !== token)) {
    problems.push('measurement must invoke pnpm run calibrate:aggregation-stress -- …');
    return null;
  }
  const args = tokens.slice(4);
  let ok = true;
  if (!(args[0] === '--pairs' && args[1] === '1')) {
    ok = false;
    problems.push('measurement must pass exactly --pairs 1 immediately after --');
  }
  if (!(args[2] === '--slot' && args[3] === `"${MATRIX_SLOT}"`)) {
    ok = false;
    problems.push('measurement --slot must be bound directly to "${{ matrix.slot }}"');
  }
  const report = args[4];
  const reportMatch = /^"\$RUNNER_TEMP\/([^"/]+\.txt)"$/.exec(report ?? '');
  if (!reportMatch || !SLOT_NAME.test(reportMatch[1].slice(0, -'.txt'.length))) {
    ok = false;
    problems.push(
      'measurement report must be "$RUNNER_TEMP/<name containing ${{ matrix.slot }}>.txt"',
    );
  }
  if (args.length !== 5) {
    ok = false;
    problems.push(
      'measurement invocation must have no argument beyond --pairs, --slot and the report',
    );
  }
  return ok ? reportMatch[1] : null;
}

function checkMeasurement(step, problems) {
  for (const key of step.entries.keys()) {
    if (!['name', 'run', 'env'].includes(key)) {
      problems.push(`measurement step must have no ${keyName(key)}`);
    }
  }
  const lines = entry(step, 'run')
    .value.split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const shapeOk =
    lines.length === MEASUREMENT_BODY.length &&
    MEASUREMENT_BODY.every((expected, index) => expected === null || lines[index] === expected);
  if (!shapeOk) {
    problems.push(
      'measurement body must be exactly: set +e / one invocation / status=$? / set -e / echo "campaign_exit=$status" / exit "$status"',
    );
  }
  const invocation = lines.find((line) => line.includes('calibrate:aggregation-stress')) ?? '';
  return checkInvocation(invocation, problems);
}

function checkUpload(step, reportName, problems) {
  for (const key of step.entries.keys()) {
    if (!['name', 'uses', 'with', 'if'].includes(key)) {
      problems.push(`upload step must have no ${keyName(key)}`);
    }
  }
  if (!plainEquals(entry(step, 'if'), 'always()')) {
    problems.push('upload step must run with if: always()');
  }
  const withMap = entry(step, 'with');
  if (withMap?.kind !== 'map') {
    problems.push('upload step must name its artifact and report path');
    return;
  }
  for (const key of withMap.entries.keys()) {
    if (!UPLOAD_WITH_KEYS.has(key)) problems.push(`upload with key ${keyName(key)} is not allowed`);
  }
  const name = entry(withMap, 'name');
  if (!isScalar(name, 'plain') || !SLOT_NAME.test(name.value)) {
    problems.push('upload artifact name must contain ${{ matrix.slot }} exactly once');
  }
  const path = entry(withMap, 'path');
  if (reportName !== null && !plainEquals(path, `\${{ runner.temp }}/${reportName}`)) {
    problems.push("upload path must be ${{ runner.temp }}/ and the measurement's report name");
  }
  if (!plainEquals(entry(withMap, 'if-no-files-found'), 'error')) {
    problems.push('upload with.if-no-files-found must be error');
  }
}

function checkGlobalValues(root, guardRun, problems) {
  for (const { node, path } of walk(root)) {
    const last = path.at(-1);
    if (node?.kind === 'map') {
      for (const key of node.entries.keys()) {
        if (key === 'continue-on-error') problems.push('continue-on-error is not allowed anywhere');
        if (key === 'permissions' && path.length > 0) {
          problems.push('permissions may only be declared once, at the workflow top level');
        }
        if (key === 'cache' || key === 'cache-dependency-path')
          problems.push('dependency caching is not allowed');
        if (RETRY_SPELLING.test(key))
          problems.push(`key ${keyName(key)} names a retry, rerun or replacement`);
      }
      continue;
    }
    if (!isScalar(node) || node === guardRun) continue;

    for (const match of node.value.matchAll(EXPRESSION)) {
      const body = match[1].trim();
      if (!/^(?:matrix\.slot|runner\.temp|github\.ref|env\.[A-Z][A-Z0-9_]*)$/.test(body)) {
        problems.push(
          `line ${node.line}: expression context is not allowed (only matrix.slot, runner.temp, github.ref, env.*)`,
        );
      }
    }
    if (node.value.replace(EXPRESSION, '').includes('${{')) {
      problems.push(`line ${node.line}: unterminated expression`);
    }
    if (last === 'name') continue; // display text only
    const executable = last === 'options' ? node.value.replace(HEALTH_RETRIES, '') : node.value;
    if (TOKEN_REFERENCE.test(executable))
      problems.push(`line ${node.line}: secrets or tokens must not be referenced`);
    if (RETRY_SPELLING.test(executable)) {
      problems.push(
        `line ${node.line}: retry, rerun, re-dispatch or replacement behaviour is not allowed`,
      );
    }
    if (last === 'run' && LOOP_KEYWORD.test(executable)) {
      problems.push(`line ${node.line}: shell loops are not allowed in the campaign job`);
    }
    if (last === 'uses') {
      if (!isScalar(node, 'plain') || !FULL_SHA_ACTION.test(node.value)) {
        problems.push(`line ${node.line}: uses must pin owner/repo@<40-hex commit SHA>`);
      } else if (/^actions\/cache@/.test(node.value) || /\/cache@/.test(node.value)) {
        problems.push('dependency caching is not allowed');
      }
    }
  }
}

/**
 * Validates the whole contract. Every problem is a bounded, fixed-vocabulary
 * sentence with at most a line number, a printable key name or a count — never
 * a value from the draft beyond those.
 */
export function validateWorkflowDraft(text) {
  if (typeof text === 'string' && Buffer.byteLength(text, 'utf8') > MAX_DRAFT_BYTES) {
    return { ok: false, problems: [`draft exceeds ${MAX_DRAFT_BYTES} bytes`] };
  }
  const parsed = parseWorkflowDraft(text);
  if (!parsed.ok) {
    return { ok: false, problems: [`malformed draft at line ${parsed.line}: ${parsed.reason}`] };
  }
  const { root } = parsed;
  const problems = [];

  for (const key of root.entries.keys()) {
    if (!TOP_LEVEL_KEYS.has(key)) problems.push(`top-level key ${keyName(key)} is not allowed`);
  }

  // Trigger: one literal push path, never a dispatch, schedule or PR event.
  const on = entry(root, 'on');
  const push = entry(on, 'push');
  const branches = entry(push, 'branches');
  const paths = entry(push, 'paths');
  const literalList = (node, pattern) =>
    node?.kind === 'seq' &&
    node.items.length === 1 &&
    isScalar(node.items[0], 'plain') &&
    pattern.test(node.items[0].value);
  if (
    on?.kind !== 'map' ||
    on.entries.size !== 1 ||
    push?.kind !== 'map' ||
    push.entries.size !== 2 ||
    !literalList(branches, /^[A-Za-z0-9._/-]+$/) ||
    !literalList(paths, /^\.github\/workflows\/[A-Za-z0-9._-]+\.yml$/)
  ) {
    problems.push(
      'on must be exactly push with one literal branch and the one installed workflow path',
    );
  }

  const concurrency = entry(root, 'concurrency');
  if (
    concurrency?.kind !== 'map' ||
    concurrency.entries.size !== 2 ||
    !isScalar(entry(concurrency, 'group')) ||
    !plainEquals(entry(concurrency, 'cancel-in-progress'), 'false')
  ) {
    problems.push('concurrency must be exactly a group with cancel-in-progress: false');
  }

  const permissions = entry(root, 'permissions');
  if (
    permissions?.kind !== 'map' ||
    permissions.entries.size !== 1 ||
    !plainEquals(entry(permissions, 'contents'), 'read')
  ) {
    problems.push('permissions must be exactly contents: read (no write permission)');
  }

  const env = entry(root, 'env');
  if (
    env !== undefined &&
    (env.kind !== 'map' || [...env.entries.values()].some(({ value }) => !isScalar(value)))
  ) {
    problems.push('env must be a mapping of scalar values');
  }

  const jobs = entry(root, 'jobs');
  let guardRun = null;
  if (jobs?.kind !== 'map' || jobs.entries.size !== 1) {
    problems.push(
      `jobs must contain exactly one campaign job, found ${jobs?.kind === 'map' ? jobs.entries.size : 0}`,
    );
  }
  const job =
    jobs?.kind === 'map' && jobs.entries.size >= 1
      ? [...jobs.entries.values()][0].value
      : undefined;

  if (job?.kind !== 'map') {
    problems.push('the campaign job must be a mapping');
  } else {
    for (const key of job.entries.keys()) {
      if (!JOB_KEYS.has(key)) problems.push(`job key ${keyName(key)} is not allowed`);
    }
    if (!plainEquals(entry(job, 'runs-on'), CAMPAIGN_RUNNER)) {
      problems.push(`runs-on must be exactly ${CAMPAIGN_RUNNER}`);
    }
    if (!plainEquals(entry(job, 'timeout-minutes'), CAMPAIGN_JOB_TIMEOUT_MINUTES)) {
      problems.push(`timeout-minutes must be exactly ${CAMPAIGN_JOB_TIMEOUT_MINUTES}`);
    }
    checkMatrix(entry(job, 'strategy'), problems);

    // § 7 / § 8.3: one fresh PostgreSQL per slot and nothing else on the machine.
    const services = entry(job, 'services');
    if (
      services?.kind !== 'map' ||
      services.entries.size !== 1 ||
      !plainEquals(entry(entry(services, 'postgres'), 'image'), CAMPAIGN_SERVICE_IMAGE)
    ) {
      problems.push(`services must be exactly one postgres container on ${CAMPAIGN_SERVICE_IMAGE}`);
    }

    const steps = entry(job, 'steps');
    if (steps?.kind !== 'seq' || steps.items.length === 0) {
      problems.push('the campaign job must have a step sequence');
    } else {
      const indexOf = (predicate) =>
        steps.items.flatMap((step, index) => (predicate(step) ? [index] : []));
      for (const step of steps.items) {
        if (step?.kind !== 'map') {
          problems.push(`line ${step?.line}: every step must be a mapping`);
          continue;
        }
        for (const key of step.entries.keys()) {
          if (!STEP_KEYS.has(key))
            problems.push(`line ${step.line}: step key ${keyName(key)} is not allowed`);
        }
        const hasRun = step.entries.has('run');
        const hasUses = step.entries.has('uses');
        if (hasRun === hasUses)
          problems.push(`line ${step.line}: a step must have exactly one of run or uses`);
        if (hasRun && !isScalar(entry(step, 'run')))
          problems.push(`line ${step.line}: run must be a scalar`);
        if (
          step.entries.has('if') &&
          !String(entry(step, 'uses')?.value ?? '').startsWith('actions/upload-artifact@')
        ) {
          problems.push(`line ${step.line}: only the report upload may carry an if: condition`);
        }
      }
      const usesOf = (step) => (step?.kind === 'map' ? (entry(step, 'uses')?.value ?? '') : '');
      const runOf = (step) =>
        step?.kind === 'map' && isScalar(entry(step, 'run')) ? entry(step, 'run').value : '';

      if (checkGuard(steps.items[0], problems)) guardRun = entry(steps.items[0], 'run');
      const attemptSteps = indexOf((step) => runOf(step).includes('github.run_attempt'));
      if (attemptSteps.some((index) => index !== 0)) {
        problems.push('github.run_attempt may be read only by the first step');
      }

      const checkouts = indexOf((step) => usesOf(step).startsWith('actions/checkout@'));
      const measurements = indexOf((step) =>
        /calibrate:aggregation-stress|aggregation-evidence\.mjs/.test(runOf(step)),
      );
      const uploads = indexOf((step) => usesOf(step).startsWith('actions/upload-artifact@'));
      if (checkouts.length !== 1)
        problems.push(`exactly one checkout step is required, found ${checkouts.length}`);
      if (measurements.length !== 1) {
        problems.push(`exactly one calibration step is required, found ${measurements.length}`);
      }
      if (uploads.length !== 1)
        problems.push(`exactly one report upload step is required, found ${uploads.length}`);

      let reportName = null;
      if (measurements.length === 1)
        reportName = checkMeasurement(steps.items[measurements[0]], problems);
      if (uploads.length === 1) checkUpload(steps.items[uploads[0]], reportName, problems);
      if (checkouts.length === 1 && checkouts[0] === 0)
        problems.push('the run_attempt guard must precede checkout');
      if (
        checkouts.length === 1 &&
        measurements.length === 1 &&
        !(checkouts[0] < measurements[0])
      ) {
        problems.push('checkout must precede the calibration step');
      }
      if (measurements.length === 1 && uploads.length === 1 && !(measurements[0] < uploads[0])) {
        problems.push('the report upload must follow the calibration step');
      }
    }
  }

  checkGlobalValues(root, guardRun, problems);
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique };
}

/** Deterministic, bounded CLI text. Never contains the draft path. */
export function formatWorkflowCheck(result) {
  const out = [
    'ADR-055 campaign workflow draft check (static; nothing installed, run or dispatched)',
  ];
  if (result.ok) {
    out.push(
      'contract holds:',
      '  one job with one postgis/postgis:16-3.4 service; matrix slot = each of 1..59 once, no other axis',
      '  fail-fast: false; runs-on: ubuntu-24.04; timeout-minutes: 45',
      '  permissions: contents: read only; concurrency cancel-in-progress: false',
      '  first step exits non-zero unless github.run_attempt == 1 (before checkout)',
      '  one calibration: --pairs 1 --slot "${{ matrix.slot }}", exit status captured and re-raised',
      '  report upload with if: always() and if-no-files-found: error, named by slot',
      '  every uses: pinned to a 40-hex commit SHA',
      '  no continue-on-error, retry/rerun, loop, dynamic matrix, caching, secret or extra trigger',
      'not provable statically: GitHub-internal infrastructure retries; that this draft governed any run',
      'RESULT: PASS',
    );
  } else {
    const shown = result.problems.slice(0, MAX_REPORTED_PROBLEMS);
    out.push(`contract violated: ${result.problems.length} problem(s)`);
    for (const problem of shown) out.push(`  - ${problem}`);
    if (result.problems.length > shown.length) {
      out.push(`  … and ${result.problems.length - shown.length} more`);
    }
    out.push('RESULT: FAIL');
  }
  return `${out.join('\n')}\n`;
}
