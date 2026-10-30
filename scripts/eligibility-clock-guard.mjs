// Eligibility-clock guard: test, fixture, script and test-support code may not
// write a column that product code compares against the DATABASE clock,
// except through the static DB-clock helpers in
// packages/testing/src/eligibility-clock.ts (or a reviewed, file-bound SQL
// probe template). A millisecond timestamptz rounds now() forward as well as
// back, so a test that writes such a column with its own clock (or with an
// unmargined now()) can flake against the product's `<= now()`.
//
// ONE SOURCE OF TRUTH (scripts/eligibility-clock-derive.mjs)
//   The gated (table, column) set is derived from every SQL literal and every
//   Prisma range filter in production source, whatever the method or file
//   name. Each clock comparison classifies or derivation throws: the column
//   must resolve in the Prisma schema to a DateTime; a value compared with a
//   DateTime column must be proved a DB-clock reading, the application clock
//   or a constant, else a reviewed SITE entry (below) must say what it is.
//   Default verdict for a DB-clock comparison: GATED. Only a reviewed site
//   entry can say "not eligibility" (a retention purge or a gauge), and an
//   entry that no longer matches a live site throws.
//
// SCOPE (scripts/eligibility-clock-scope.mjs)
//   Test entry points, followed by import graph; production roots are never
//   enforced. See that file's header for both definitions.
//
// WHAT IS REFUSED in enforced files
//   SQL (string, template, `+` concatenation, `[...].join()`, tagged
//   templates, *.sql fixtures; comments stripped string-aware):
//     - any gated column in a SET list (any position, row-constructor
//       `SET (a, b) = (...)`, ON CONFLICT DO UPDATE SET) or INSERT/COPY
//       column list, whatever the value;
//     - a spliced value in column position, an empty SET list, or an INSERT
//       without a column list, on a table that has a gated column;
//     - `UPDATE ${table}` / `INSERT INTO ${table}` that writes a column name
//       gated on any table, or that splices its column list.
//   A splice in table or column position must resolve to literal text (const
//   bindings, arrays and objects nothing can change, their .map()/.join(),
//   it.each rows, callers' arguments) or the statement refuses; a const array
//   or object that is pushed to, assigned into or handed to a function no
//   longer counts as its literal.
//   ORM (Prisma model calls): any data/create/update object that carries a
//   gated field of that model, followed through variables, spreads, arrays,
//   .map()/.flatMap() row builders, conditionals and local or imported
//   test-support functions; a data flow that cannot be followed (a
//   parameter, an unresolved call, a computed key) refuses when the model
//   has a gated field. Object literals carrying a gated field that are handed
//   to an enforced helper are followed into it; to an unresolvable function,
//   they refuse.
//   Zero lease/backoff/delay options and positional zero leases (signatures
//   read from declared parameter names).
//
// LIMITS (enforced statically only as described; nothing here is exempt)
//   - Values handed to PRODUCTION code (a repository, a service, an HTTP
//     body) are product inputs: the guard does not trace into production.
//   - Method calls on objects whose class is not statically known (a Nest
//     provider from the testing module) are treated as product calls unless
//     the call is Prisma-shaped ({data|create|update}) or the receiver is a
//     dynamic Prisma delegate.
//   - The application clock: product comparisons against `new Date()` are
//     listed (verdict application-clock) but do not gate; this guard is about
//     the database clock.
//   - SQL is read where it is written: every SQL-shaped literal of an
//     enforced file, whatever call it reaches, and every *.sql fixture. Text
//     that never appears as a literal in an enforced file (read from another
//     file type, the environment or JSON, or returned by production code) is
//     not read; a call that executes such text is not refused.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import ts from 'typescript';
import { clockSites, createFlow, readSchemas, walk } from './eligibility-clock-derive.mjs';
import { PLACEHOLDER, analyse } from './eligibility-clock-sql.mjs';
import { scope as testScope } from './eligibility-clock-scope.mjs';

// ---------------------------------------------------------------------------
// Reviewed site classifications. Keyed by `<file>#<function>`; `columns`
// names the columns the entry speaks for. Verdicts:
//   not-db-clock     the compared value is not a DB-clock reading (request
//                    input, a stored instant, the application clock), shown
//                    by reading the callers; the column is not gated by it.
//   not-eligibility  a DB-clock comparison that only feeds a gauge, an alert
//                    count or a day-scale retention purge; no state machine
//                    or claim depends on it.
//   gated            a value the resolver cannot follow that IS a DB-clock
//                    reading; the column is gated.
export const REVIEWED_SITES = [
  {
    site: 'services/analytics-service/src/kpis/kpi.repository.ts#read',
    columns: ['completed_at', 'period_start', 'period_end'],
    verdict: 'not-db-clock',
    reason:
      'from/to are the KPI request window (kpi.service.ts:33, query input); period bounds match stored baseline rows',
  },
  {
    site: 'services/analytics-service/src/maintenance/maintenance-fact.repository.ts#fleetMaintenance',
    columns: ['completed_at'],
    verdict: 'not-db-clock',
    reason: 'from/to are the dashboard request window (dashboard.service.ts:28)',
  },
  {
    site: 'services/asset-service/src/asset/asset.repository.ts#findInspectionsExpiringWithin',
    columns: ['valid_to'],
    verdict: 'not-db-clock',
    reason:
      'cutoff = new Date(Date.now() + days) and new Date(): application clock (asset.repository.ts:250-252)',
  },
  {
    site: 'services/asset-service/src/asset/asset.repository.ts#findPoliciesExpiringWithin',
    columns: ['valid_to'],
    verdict: 'not-db-clock',
    reason:
      'cutoff = new Date(Date.now() + days) and new Date(): application clock (asset.repository.ts:242-244)',
  },
  {
    site: 'services/asset-service/src/asset/asset.repository.ts#list',
    columns: ['valid_to'],
    verdict: 'not-db-clock',
    reason:
      'cutoff = new Date(Date.now() + query.expiringWithinDays): application clock (asset.repository.ts:146)',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#chainSegment',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason:
      'lower/to are the verification request range (audit.verification.service.ts:142, query.from/to)',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#chainWhere',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason: 'start/end are monthBounds(key.chainMonth) of a stored chain key',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#countMissingReconciliationEvidence',
    columns: ['recorded_at'],
    verdict: 'not-db-clock',
    reason:
      'since = now - look-back with now = new Date() (reconciliation-evidence-monitor.ts:56-59): application clock',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#findById',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason: 'window is the request query.from/to (audit.query.service.ts:123)',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#findCorrectionIds',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason:
      'earliest is the smallest stored occurredAt of the page rows (audit.repository.ts:869-871)',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#ingest',
    columns: ['chain_month'],
    verdict: 'not-db-clock',
    reason: 'chain_month equality with the event key month, a stored DATE, not an instant',
  },
  {
    site: 'services/audit-service/src/audit/audit.repository.ts#search',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason: 'filters.from/to and the cursor are request input',
  },
  {
    site: 'services/construction-service/src/shared/idempotency-forget.ts#forgettableWhere',
    columns: ['expires_at'],
    verdict: 'not-db-clock',
    reason:
      'nowMs is Date.now() via IdempotencyService.nowMs (idempotency.ts:308): application clock',
  },
  {
    site: 'services/contract-service/src/amendment/amendment.repository.ts#flagRacedSignatures',
    columns: ['hierarchy_commit_deadline'],
    verdict: 'not-db-clock',
    reason:
      'skewedBound = earliestMoveInstant (the move event instant, policy-suspension.service.ts:425) minus a margin',
  },
  {
    site: 'services/contract-service/src/contract/contract.repository.ts#flagRacedSignatures',
    columns: ['hierarchy_commit_deadline'],
    verdict: 'not-db-clock',
    reason:
      'skewedBound = earliestMoveInstant (the move event instant, policy-suspension.service.ts:387) minus a margin',
  },
  {
    site: 'services/contract-service/src/policy/policy.repository.ts#listUnionPoliciesToReconfirm',
    columns: ['hierarchy_commit_deadline'],
    verdict: 'not-db-clock',
    reason:
      'skewedBound = move.movedAt (event instant, policy-suspension.service.ts:155) minus a margin',
  },
  {
    site: 'services/contract-service/src/shared/idempotency.ts#firstRefusal',
    columns: ['expires_at'],
    verdict: 'not-db-clock',
    reason:
      'claimedAt is the claimOnce now = new Date() (idempotency.ts:407,425): application clock',
  },
  {
    site: 'services/contract-service/src/shared/idempotency.ts#purgeExpired',
    columns: ['expires_at'],
    verdict: 'not-db-clock',
    reason:
      'leaseAgo = new Date() minus the claim lease (idempotency.ts:566-572): application clock',
  },
  {
    site: 'services/economic-service/src/payment/payment-reconciliation.repository.ts#heal',
    columns: ['created_at'],
    verdict: 'not-db-clock',
    reason:
      '($2, $3) is the keyset cursor carried from the stored rows of the previous page (sweeper.ts:153)',
  },
  {
    site: 'services/fleet-service/src/fleet/fleet.repository.ts#assignmentCounts',
    columns: ['started_at', 'ended_at'],
    verdict: 'not-db-clock',
    reason:
      'from/to are the utilization window: query input or new Date() (availability.service.ts:318-322)',
  },
  {
    site: 'services/fleet-service/src/fleet/fleet.repository.ts#findOverlappingUsage',
    columns: ['period_start', 'period_end'],
    verdict: 'not-db-clock',
    reason: 'the period of the new usage record itself, request input',
  },
  {
    site: 'services/fleet-service/src/fleet/fleet.repository.ts#findWindowsInForce',
    columns: ['from_at', 'to_at'],
    verdict: 'not-db-clock',
    reason: 'at = query.at or new Date() (availability.service.ts:62)',
  },
  {
    site: 'services/fleet-service/src/fleet/fleet.repository.ts#listAssignments',
    columns: ['started_at'],
    verdict: 'not-db-clock',
    reason: 'new Date(query.from/to): request filters',
  },
  {
    site: 'services/fleet-service/src/fleet/fleet.repository.ts#listUsage',
    columns: ['period_end'],
    verdict: 'not-db-clock',
    reason: 'new Date(query.from/to): request filters',
  },
  {
    site: 'services/fleet-service/src/fleet/fleet.repository.ts#usageTotals',
    columns: ['period_end'],
    verdict: 'not-db-clock',
    reason:
      'from/to are the utilization window: query input or new Date() (availability.service.ts:318-322)',
  },
  {
    site: 'services/identity-service/src/identity/identity.repository.ts#countLapsedMemberships',
    columns: ['valid_until'],
    verdict: 'gated',
    reason:
      'now = databaseNow(tx), clock_timestamp() read in the same transaction (keycloak-fence-sampler.ts:140)',
  },
  {
    site: 'services/identity-service/src/identity/identity.repository.ts#findLapsedMemberships',
    columns: ['valid_until'],
    verdict: 'not-db-clock',
    reason:
      'now = scan(now = new Date()) prefilter (membership-expiry.scanner.ts:230, :274); each lapse is re-decided against databaseNow under lock (identity.service.ts:1787)',
  },
  {
    site: 'services/identity-service/src/identity/identity.repository.ts#findOrganizationIdsSince',
    columns: ['valid_until', 'deleted_at'],
    verdict: 'not-db-clock',
    reason:
      'from is the history lower bound the caller passes (an earlier bid-opening instant); the upper bound t.now is classified as a DB-clock site',
  },
  {
    site: 'services/identity-service/src/identity/identity.service.ts#expireLapsedMembership',
    columns: ['valid_until'],
    verdict: 'gated',
    reason: 'now = databaseNow(tx) after the membership lock (identity.service.ts:1787)',
  },
  {
    site: 'services/identity-service/src/keycloak/keycloak-write-fence.ts#ofUser',
    columns: ['takeover_at'],
    verdict: 'gated',
    reason:
      'now = databaseNow(tx) read after the user lock by both callers (keycloak.projector.ts:493, :852)',
  },
  {
    site: 'services/maintenance-service/src/maintenance/maintenance.repository.ts#listRequests',
    columns: ['reported_at'],
    verdict: 'not-db-clock',
    reason: 'new Date(query.from/to): request filters',
  },
  {
    site: 'services/marketplace-service/src/order/order.repository.ts#hasSagaHistorySince',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason: 'since = saga.scheduledAt minus skew (order.service.ts:1532-1533), a stored instant',
  },
  {
    site: 'services/notification-service/src/api/in-app.repository.ts#listPage',
    columns: ['created_at'],
    verdict: 'not-db-clock',
    reason: 'the keyset cursor from the previous page (request input)',
  },
  {
    site: 'services/notification-service/src/api/in-app.repository.ts#owned',
    columns: ['expires_at'],
    verdict: 'not-db-clock',
    reason: 'now = new Date() supplied by notification.service.ts:57: application clock',
  },
  {
    site: 'services/organization-service/src/organization/organization.service.ts#setPolicy',
    columns: ['effective_to', 'effective_from'],
    verdict: 'not-db-clock',
    reason:
      'overlap test between the period bounds of the new policy (request input or new Date())',
  },
  {
    site: 'services/supplier-service/src/performance/concluded-outcome.repository.ts#listInWindow',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason: 'no production caller; tests pass fixed Date constants',
  },
  {
    site: 'services/supplier-service/src/performance/performance-event.repository.ts#listInWindow',
    columns: ['occurred_at'],
    verdict: 'not-db-clock',
    reason: 'no production caller; tests pass fixed Date constants',
  },
  {
    site: 'packages/nest-common/src/outbox/outbox-sql.ts#purgePublishedSql',
    columns: ['published_at', 'created_at'],
    verdict: 'not-eligibility',
    reason:
      'retention purge: deletes published rows older than the retention window (days); no claim or publish decision reads it',
  },
  {
    site: 'services/construction-service/src/tender/award-standing-check.repository.ts#backlog',
    columns: ['created_at'],
    verdict: 'not-eligibility',
    reason:
      'backlog gauge (count, oldest age); claimDue gates on next_attempt_at and lease_until only',
  },
  {
    site: 'services/audit-service/src/audit/tender-evidence.repository.ts#pendingSummary',
    columns: ['held_at'],
    verdict: 'not-eligibility',
    reason:
      'gap monitor gauges and the once-per-gap alert counter (tender-gap-monitor.ts:51); no receipt state changes on it',
  },
];

function lineOf(ast, node) {
  return ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
}

/**
 * The gate: {gated: Map('table.column' -> info), sites, schemas}. Throws on any
 * unclassified clock use, unresolved compared value or stale review.
 */
export function deriveGate(repository, options = {}) {
  const schemas = options.schemas ?? readSchemas(repository);
  const flow = options.flow ?? createFlow(repository);
  const reviewed = options.reviewedSites ?? REVIEWED_SITES;
  const { sites, problems } = clockSites(repository, schemas, flow);
  const used = new Set();
  const classified = [];
  for (const site of sites) {
    const review = reviewed.find(
      (r) => r.site === `${site.file}#${site.fn}` && r.columns.includes(site.column),
    );
    let verdict;
    if (site.source.startsWith('unresolved')) {
      if (!review) {
        problems.push(
          `${site.file}:${site.line}: ${site.table}.${site.column} compared with a value of unproven origin (${site.fn})`,
        );
        continue;
      }
      if (review.verdict === 'not-eligibility')
        throw new Error(`review ${review.site}: not-eligibility applies to DB-clock sites only`);
      verdict = review.verdict === 'gated' ? 'gated' : 'not-db-clock';
    } else if (site.source.startsWith('application clock')) verdict = 'application-clock';
    else if (review?.verdict === 'not-eligibility') verdict = 'not-eligibility';
    else if (review && review.verdict !== 'gated')
      throw new Error(`review ${review.site}: ${review.verdict} contradicts a DB-clock comparison`);
    else verdict = 'gated';
    if (review) used.add(review);
    classified.push({ ...site, verdict, reason: review?.reason });
  }
  if (problems.length) throw new Error(`unclassified clock use:\n${problems.join('\n')}`);
  const stale = reviewed.filter((r) => !used.has(r));
  if (stale.length) throw new Error(`stale site reviews: ${stale.map((r) => r.site).join(', ')}`);
  const gated = new Map();
  for (const site of classified.filter((s) => s.verdict === 'gated')) {
    const key = `${site.table}.${site.column}`;
    const entry = gated.get(key) ?? {
      table: site.table,
      column: site.column,
      fields: new Set(),
      delegates: new Set(),
      schema: new Set(),
      evidence: [],
    };
    entry.evidence.push(`${site.file}:${site.line} (${site.fn}, ${site.source})`);
    gated.set(key, entry);
  }
  // Every schema that maps that table: delegates and field names.
  for (const entry of gated.values())
    for (const model of schemas.tables.get(entry.table) ?? []) {
      const column = model.columns.get(entry.column);
      if (!column) continue;
      entry.fields.add(column.field);
      entry.delegates.add(model.delegate);
      entry.schema.add(column.location);
    }
  if (!gated.size) throw new Error('no gated clock columns');
  return { gated, sites: classified, schemas, flow };
}

/** Lookup structures the test-side checks use. */
export function gateIndex(gate) {
  const byTable = new Map();
  const columnNames = new Set();
  const fieldsByDelegate = new Map();
  const fieldNames = new Set();
  for (const entry of gate.gated.values()) {
    byTable.set(entry.table, new Set([...(byTable.get(entry.table) ?? []), entry.column]));
    columnNames.add(entry.column);
    for (const model of gate.schemas.tables.get(entry.table) ?? []) {
      const field = model.columns.get(entry.column)?.field;
      if (!field) continue;
      fieldsByDelegate.set(
        model.delegate,
        new Set([...(fieldsByDelegate.get(model.delegate) ?? []), field]),
      );
      fieldNames.add(field);
    }
  }
  const models = new Map();
  for (const entries of gate.schemas.delegates.values())
    for (const e of entries) models.set(e.model, e.delegate);
  const relations = new Map(); // delegate -> Map(field -> delegate)
  for (const [delegate, entries] of gate.schemas.delegates)
    for (const e of entries)
      for (const [, column] of e.columns)
        if (models.has(column.type)) {
          const map = relations.get(delegate) ?? new Map();
          map.set(column.field, models.get(column.type));
          relations.set(delegate, map);
        }
  return {
    byTable,
    columnNames,
    fieldsByDelegate,
    fieldNames,
    delegates: gate.schemas.delegates,
    relations,
  };
}

// ---------------------------------------------------------------------------
// Reviewed SQL probe templates, bound to their file and their substitutions.

export function reviewedTemplates(repository) {
  const source = readFileSync(
    join(repository, 'packages/testing/src/eligibility-clock.ts'),
    'utf8',
  );
  const ast = ts.createSourceFile('helper.ts', source, ts.ScriptTarget.Latest, true);
  let result;
  walk(ast, (node) => {
    if (!ts.isVariableDeclaration(node) || node.name.getText(ast) !== 'reviewedClockTemplates')
      return;
    const value = ts.isAsExpression(node.initializer)
      ? node.initializer.expression
      : node.initializer;
    if (!ts.isArrayLiteralExpression(value)) throw new Error('malformed clock template allowlist');
    result = value.elements.map((element) => {
      if (!ts.isObjectLiteralExpression(element))
        throw new Error('malformed clock template allowlist');
      const entry = {};
      for (const p of element.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name))
          throw new Error('malformed clock template allowlist');
        if (ts.isStringLiteral(p.initializer)) entry[p.name.text] = p.initializer.text;
        else if (p.initializer.kind === ts.SyntaxKind.NullKeyword) entry[p.name.text] = null;
        else throw new Error('malformed clock template allowlist');
      }
      if (
        typeof entry.file !== 'string' ||
        !/^[0-9a-f]{64}$/.test(entry.template ?? '') ||
        !('expressions' in entry)
      )
        throw new Error('malformed clock template allowlist');
      return entry;
    });
  });
  if (!result?.length) throw new Error('missing clock template allowlist');
  return result;
}

export function templateHash(node) {
  const raw = ts.isTemplateExpression(node)
    ? [node.head.rawText, ...node.templateSpans.map((s) => s.literal.rawText)]
    : [node.rawText];
  return createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

export function expressionHash(node, ast) {
  const printer = ts.createPrinter({ removeComments: true });
  const expressions = ts.isTemplateExpression(node)
    ? node.templateSpans.map((s) => printer.printNode(ts.EmitHint.Expression, s.expression, ast))
    : [];
  return createHash('sha256').update(JSON.stringify(expressions)).digest('hex');
}

// ---------------------------------------------------------------------------
// Lease signatures (zero leases), unchanged in substance from r1.

function name(node, ast) {
  if (!node) return '';
  if (ts.isComputedPropertyName(node)) return constantText(node.expression) ?? '${value}';
  return ts.isStringLiteralLike(node) || ts.isIdentifier(node) ? node.text : node.getText(ast);
}

function constantText(node) {
  if (ts.isParenthesizedExpression(node)) return constantText(node.expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const [l, r] = [constantText(node.left), constantText(node.right)];
    return l === null || r === null ? null : l + r;
  }
  return null;
}

function zero(node) {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isPrefixUnaryExpression(node))
    return zero(node.operand ?? node.expression);
  return ts.isNumericLiteral(node) && Number(node.text) === 0;
}

export function leaseSignatures(repository, flow = createFlow(repository)) {
  const result = new Map();
  for (const [, ast] of flow.sources)
    walk(ast, (node) => {
      if (!node.parameters || !/claim/i.test(node.name?.getText(ast) ?? '')) return;
      for (const [index, param] of node.parameters.entries())
        if (/lease|backoff|delay/i.test(param.name.getText(ast))) {
          const key = node.name.getText(ast);
          const indices = result.get(key) ?? new Set();
          indices.add(index);
          result.set(key, indices);
        }
    });
  return result;
}

// ---------------------------------------------------------------------------
// SQL in enforced files.

const unwrapTs = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)))
  )
    node = node.expression;
  return node;
};

function constBinding(identifier, ast) {
  const d = declarationOf(identifier, ast);
  return d?.kind === 'variable' && d.node.parent.flags & ts.NodeFlags.Const
    ? (d.node.initializer ?? null)
    : null;
}

/** Compose SQL text from literal pieces; anything else is a placeholder. */
function composeSql(node, ast, depth = 0) {
  const spans = [];
  const go = (n, d) => {
    n = unwrapTs(n);
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text;
      for (const span of n.templateSpans) out += go(span.expression, d + 1) + span.literal.text;
      return out;
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return go(n.left, d) + go(n.right, d);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'join' &&
      ts.isArrayLiteralExpression(unwrapTs(n.expression.expression))
    ) {
      const sep = n.arguments[0] ? constantText(n.arguments[0]) : ',';
      if (sep !== null)
        return unwrapTs(n.expression.expression)
          .elements.map((e) => go(e, d))
          .join(sep);
    }
    if (ts.isIdentifier(n) && d < 4) {
      const bound = constBinding(n, ast);
      if (bound && isSqlish(bound)) return go(bound, d + 1);
    }
    spans.push(n);
    return PLACEHOLDER(spans.length - 1);
  };
  const text = go(node, depth);
  return { text, spans };
}

function isSqlish(node) {
  node = unwrapTs(node);
  return (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
    (ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'join' &&
      ts.isArrayLiteralExpression(unwrapTs(node.expression.expression)))
  );
}

/** Is this node the outermost piece of a SQL composition? */
function sqlRoot(node) {
  if (!isSqlish(node)) return false;
  let parent = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)))
    parent = parent.parent;
  if (!parent) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    return false;
  if (ts.isTemplateSpan(parent)) return false;
  if (
    ts.isArrayLiteralExpression(parent) &&
    ts.isPropertyAccessExpression(parent.parent) &&
    parent.parent.name.text === 'join' &&
    ts.isCallExpression(parent.parent.parent)
  )
    return false;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name.text === 'join' &&
    ts.isArrayLiteralExpression(unwrapTs(node))
  )
    return false;
  return true;
}

const WRITE_WORD = /\b(?:update|insert|copy|set)\b/i;

/** SQL write findings for one composed statement text. */
export function sqlWriteFindings(text, index) {
  if (!WRITE_WORD.test(text)) return [];
  const a = analyse(text, () => 'unknown');
  const t = a.tokens;
  const findings = [];
  const word = (k, ...v) => t[k]?.type === 'word' && v.includes(t[k].lower);
  const name = (k) =>
    t[k]?.type === 'word' || t[k]?.type === 'quoted' || t[k]?.type === 'placeholder';
  // INSERT INTO <t> must go on like SQL: (cols), VALUES, SELECT, DEFAULT, a splice or `.`.
  const insertBody = (k) => {
    while (t[k]?.value === '.' && name(k + 1)) k += 2;
    if (word(k, 'as')) k += 2;
    return (
      t[k]?.value === '(' ||
      word(k, 'values', 'select', 'default', 'with', 'overriding') ||
      t[k]?.type === 'placeholder' ||
      t[k] === undefined
    );
  };
  // ALTER … SET / a session SET is configuration, not a column write.
  const alterBefore = (k) => {
    for (let i = k - 1; i >= 0 && t[i].value !== ';'; i -= 1) if (word(i, 'alter')) return true;
    return (
      word(k - 1, 'local', 'session') || ((k === 0 || t[k - 1]?.value === ';') && word(k + 2, 'to'))
    );
  };
  // Only statement shapes are writes: UPDATE <t> … SET, INSERT INTO <t>, COPY <t>,
  // ON CONFLICT … DO UPDATE SET, or a SET-list fragment `SET <column> =`.
  let statement = false;
  for (let k = 0; k < t.length && !statement; k += 1) {
    if (
      word(k, 'update') &&
      (name(k + 1) || word(k + 1, 'only')) &&
      t.slice(k + 2).some((x) => x.type === 'word' && x.lower === 'set')
    )
      statement = true;
    else if (word(k, 'insert') && word(k + 1, 'into') && name(k + 2) && insertBody(k + 3))
      statement = true;
    else if (
      word(k, 'copy') &&
      name(k + 1) &&
      t.slice(k + 2).some((x) => x.type === 'word' && x.lower === 'from')
    )
      statement = true;
    else if (
      word(k, 'set') &&
      !alterBefore(k) &&
      (name(k + 1) || t[k + 1]?.value === '(') &&
      t.slice(k + 2, k + 12).some((x) => x.type === 'op' && x.value === '=')
    )
      statement = true;
  }
  if (!statement) return [];
  const targets = a.tables.filter(
    (r) =>
      r.keyword === 'update' ||
      r.keyword === 'into' ||
      (r.keyword === 'from' && word(r.index - 1, 'copy')),
  );
  const copyTargets = [];
  for (let k = 0; k < t.length; k += 1)
    if (word(k, 'copy')) {
      const n = t[k + 1];
      if (n?.type === 'placeholder') copyTargets.push({ table: null, dynamic: true, index: k + 1 });
      else if (n && (n.type === 'word' || n.type === 'quoted'))
        copyTargets.push({
          table: n.type === 'quoted' ? n.value.toLowerCase() : n.lower,
          index: k + 1,
        });
    }
  const targetBefore = (pos, preferInsert) => {
    const candidates = targets.filter(
      (r) => r.index < pos && (!preferInsert || r.keyword === 'into'),
    );
    return candidates.at(-1) ?? null;
  };
  const gatedOn = (table, column) => index.byTable.get(table)?.has(column) ?? false;
  const anyGated = (column) => index.columnNames.has(column);
  const tableHasGate = (table) => index.byTable.has(table);
  const check = (target, columns, dynamicColumns, what) => {
    if (!target) {
      // A SET fragment with no UPDATE/INSERT in this text: the splice point
      // (an UPDATE … SET ${fragment}) is where its table is known; here only a
      // column name gated on some table is reported.
      for (const c of columns)
        if (anyGated(c)) findings.push(`direct SQL eligibility write (${c}, table unknown)`);
      return;
    }
    if (target.dynamic) {
      for (const c of columns)
        if (anyGated(c)) findings.push(`direct SQL eligibility write (${c}, dynamic table)`);
      if (dynamicColumns) findings.push(`unclassified SQL write columns (dynamic table)`);
      return;
    }
    for (const c of columns)
      if (gatedOn(target.table, c))
        findings.push(`direct SQL eligibility write (${target.table}.${c})`);
    if (dynamicColumns && tableHasGate(target.table))
      findings.push(`unclassified SQL write columns (${target.table} ${what})`);
  };
  const setIndices = [];
  for (let k = 0; k < t.length; k += 1)
    if (word(k, 'set') && !word(k - 1, 'character', 'char')) setIndices.push(k);
  const governing = (op) => setIndices.filter((s) => s < op).at(-1);
  for (const w of a.writes) {
    if (w.kind === 'insert') {
      const target = a.tables.find((r) => r.keyword === 'into' && r.index > w.op) ?? null;
      check(
        target,
        w.columns.map((c) => (typeof c === 'string' ? c : c.name)),
        w.dynamic,
        w.columns.length ? 'insert columns' : 'insert without a column list',
      );
      continue;
    }
    const set = governing(w.op);
    const onConflict = set !== undefined && word(set - 1, 'update') && word(set - 2, 'do');
    const target = set === undefined ? null : targetBefore(set, onConflict);
    check(
      target,
      w.columns.map((c) => c.name),
      w.dynamic,
      'SET list',
    );
  }
  for (const s of setIndices) {
    // An empty or truncated SET list: the assignments come from elsewhere.
    const next = t[s + 1];
    if (!next || next.value === ';' || word(s + 1, 'where', 'from', 'returning')) {
      const onConflict = word(s - 1, 'update') && word(s - 2, 'do');
      check(targetBefore(s, onConflict), [], true, 'empty SET list');
    }
  }
  for (const c of copyTargets) {
    // COPY t (cols) FROM ...: like an INSERT column list.
    const open = t[c.index + 1]?.value === '(' ? c.index + 1 : -1;
    const columns = [];
    let dynamic = open < 0;
    if (open >= 0)
      for (let k = open + 1; k < t.length && t[k].value !== ')'; k += 1)
        if (t[k].type === 'word' || t[k].type === 'quoted')
          columns.push(t[k].type === 'quoted' ? t[k].value.toLowerCase() : t[k].lower);
        else if (t[k].type === 'placeholder') dynamic = true;
    if (word(c.index + (open >= 0 ? 0 : 1), 'to') || word(c.index - 1, 'to')) continue;
    check(c, columns, dynamic, 'COPY');
  }
  return [...new Set(findings)];
}

// ---------------------------------------------------------------------------
// ORM data flow in enforced files.

const PRISMA_WRITES = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
]);
const DATA_KEYS = new Set(['data', 'create', 'update']);
const ASSERTIONS =
  /(?:^|\.)(?:toMatchObject|toEqual|toStrictEqual|objectContaining|toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith|deepEqual|deepStrictEqual|partialDeepStrictEqual|equal|strictEqual|toContainEqual|toMatchInlineSnapshot|toMatchSnapshot|arrayContaining)$/;

/** Per-file context for following data flows (including into imported helpers). */
export function fileContext(local, ast, project) {
  return { local, ast, project };
}

// Declarations per file: name -> [{kind, node, scope}], built once per AST.
const declarationIndexes = new WeakMap();
function declarationsOf(ast) {
  let index = declarationIndexes.get(ast);
  if (index) return index;
  index = new Map();
  const add = (name, entry) => index.set(name, [...(index.get(name) ?? []), entry]);
  walk(ast, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name))
      add(n.name.text, { kind: 'variable', node: n, scope: n.parent.parent?.parent ?? ast });
    else if (ts.isParameter(n) && ts.isIdentifier(n.name))
      add(n.name.text, { kind: 'parameter', node: n, scope: n.parent });
    else if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
      let p = n.parent;
      while (p && !ts.isVariableDeclaration(p) && !ts.isParameter(p)) p = p.parent;
      add(n.name.text, {
        kind: p && ts.isParameter(p) ? 'parameter' : 'binding',
        node: n,
        scope: p && ts.isParameter(p) ? p.parent : (p?.parent?.parent?.parent ?? ast),
      });
    } else if (ts.isFunctionDeclaration(n) && n.name)
      add(n.name.text, { kind: 'function', node: n, scope: n.parent });
    else if (ts.isImportSpecifier(n)) add(n.name.text, { kind: 'import', node: n, scope: ast });
    else if (ts.isImportClause(n) && n.name)
      add(n.name.text, { kind: 'import-default', node: n, scope: ast });
    else if (ts.isNamespaceImport(n))
      add(n.name.text, { kind: 'import-namespace', node: n, scope: ast });
    else if (ts.isClassDeclaration(n) && n.name)
      add(n.name.text, { kind: 'class', node: n, scope: n.parent });
  });
  declarationIndexes.set(ast, index);
  return index;
}

function declarationOf(identifier, ast) {
  // Innermost declaration (variable, binding, parameter, function, import) visible at the identifier.
  let best = null;
  for (const c of declarationsOf(ast).get(identifier.text) ?? []) {
    if (!c.scope || c.scope.pos > identifier.pos || identifier.end > c.scope.end) continue;
    if (!best || c.scope.pos >= best.scope.pos) best = c;
  }
  return best;
}

/**
 * Fields an expression may contribute to a Prisma data object:
 * {fields: Set, unprovable: [reason], relations: [{field, value}]}
 */
function dataFields(expression, ctx, depth = 0, seen = new Set()) {
  const out = { fields: new Set(), unprovable: [], nested: [] };
  const merge = (r) => {
    r.fields.forEach((f) => out.fields.add(f));
    out.unprovable.push(...r.unprovable);
    out.nested.push(...r.nested);
  };
  const node = unwrapTs(expression);
  if (!node || depth > 8) {
    out.unprovable.push('data flow too deep');
    return out;
  }
  if (seen.has(node)) return out;
  seen = new Set(seen).add(node);
  const again = (n, d = depth + 1) => dataFields(n, ctx, d, seen);
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isSpreadAssignment(p)) merge(again(p.expression));
      else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        if (ts.isComputedPropertyName(p.name) && constantText(p.name.expression) === null) {
          out.unprovable.push('computed key');
          continue;
        }
        const key = name(p.name, ctx.ast);
        out.fields.add(key);
        if (ts.isPropertyAssignment(p)) out.nested.push({ field: key, value: p.initializer });
      } else if (ts.isMethodDeclaration(p) || ts.isGetAccessor(p))
        out.fields.add(name(p.name, ctx.ast));
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const e of node.elements) merge(again(ts.isSpreadElement(e) ? e.expression : e));
    return out;
  }
  if (ts.isConditionalExpression(node)) {
    merge(again(node.whenTrue));
    merge(again(node.whenFalse));
    return out;
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(node.operatorToken.kind)
  ) {
    merge(again(node.right));
    if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) merge(again(node.left));
    return out;
  }
  if (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  )
    return out;
  if (ts.isCallExpression(node)) {
    const callee = unwrapTs(node.expression);
    // Row builders: xs.map(cb), xs.flatMap(cb), Array.from(xs, cb).
    if (
      ts.isPropertyAccessExpression(callee) &&
      ['map', 'flatMap'].includes(callee.name.text) &&
      node.arguments[0]
    ) {
      merge(returnsOf(node.arguments[0], ctx, depth, seen));
      return out;
    }
    if (callee.getText(ctx.ast) === 'Array.from' && node.arguments[1]) {
      merge(returnsOf(node.arguments[1], ctx, depth, seen));
      return out;
    }
    if (callee.getText(ctx.ast) === 'Object.assign') {
      for (const a of node.arguments) merge(again(a));
      return out;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ['filter', 'slice', 'concat', 'reverse', 'sort'].includes(callee.name.text)
    ) {
      merge(again(callee.expression));
      for (const a of callee.name.text === 'concat' ? node.arguments : []) merge(again(a));
      return out;
    }
    const target = resolveFunction(callee, ctx);
    if (target) {
      merge(returnsOf(target.node, target.ctx, depth, seen));
      return out;
    }
    out.unprovable.push(`unresolved call ${callee.getText(ctx.ast).slice(0, 40)}`);
    return out;
  }
  if (ts.isIdentifier(node)) {
    const d = declarationOf(node, ctx.ast);
    if (!d) {
      out.unprovable.push(`unknown ${node.text}`);
      return out;
    }
    if (d.kind === 'variable') {
      if (d.node.initializer) merge(again(d.node.initializer));
      // Later assignments and property writes to the same binding.
      walk(d.scope, (n) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const left = unwrapTs(n.left);
          if (ts.isIdentifier(left) && left.text === node.text && n.left !== node)
            merge(again(n.right));
          if (
            ts.isPropertyAccessExpression(left) &&
            ts.isIdentifier(left.expression) &&
            left.expression.text === node.text
          )
            out.fields.add(left.name.text);
          if (
            ts.isElementAccessExpression(left) &&
            ts.isIdentifier(left.expression) &&
            left.expression.text === node.text
          ) {
            const key = constantText(left.argumentExpression);
            if (key === null) out.unprovable.push('computed property write');
            else out.fields.add(key);
          }
        }
        if (
          ts.isCallExpression(n) &&
          n.expression.getText(ctx.ast) === 'Object.assign' &&
          n.arguments[0] &&
          ts.isIdentifier(n.arguments[0]) &&
          n.arguments[0].text === node.text
        )
          for (const a of n.arguments.slice(1)) merge(again(a));
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ['push', 'unshift'].includes(n.expression.name.text) &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === node.text
        )
          for (const a of n.arguments) merge(again(a));
      });
      return out;
    }
    if (d.kind === 'binding') {
      const pattern = d.node.parent;
      if (
        d.node.dotDotDotToken &&
        ts.isObjectBindingPattern(pattern) &&
        ts.isVariableDeclaration(pattern.parent) &&
        pattern.parent.initializer
      ) {
        // `const { a, ...rest } = X`: X's fields without the named ones.
        const named = new Set(
          pattern.elements
            .filter((e) => e !== d.node)
            .map((e) => (e.propertyName ?? e.name).getText(ctx.ast)),
        );
        const r = again(pattern.parent.initializer);
        r.fields.forEach((f) => !named.has(f) && out.fields.add(f));
        out.unprovable.push(...r.unprovable);
        return out;
      }
      const sources = bindingSources(d.node, ctx);
      if (sources.every((v) => v !== null)) {
        for (const v of sources) merge(again(v));
        return out;
      }
    }
    if (d.kind === 'parameter' || d.kind === 'binding') {
      // Follow the callers of a local function, else unprovable.
      const followed = d.kind === 'parameter' ? parameterValues(d, ctx) : null;
      if (followed) for (const [arg, c] of followed) merge(dataFields(arg, c, depth + 1, seen));
      else out.unprovable.push(`${d.kind} ${node.text}`);
      return out;
    }
    out.unprovable.push(`${d.kind} ${node.text}`);
    return out;
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    out.unprovable.push(`property ${node.getText(ctx.ast).slice(0, 40)}`);
    return out;
  }
  if (ts.isAwaitExpression(node)) return again(node.expression, depth);
  if (
    ts.isNewExpression(node) ||
    ts.isFunctionLike(node) ||
    ts.isLiteralExpression(node) ||
    ts.isTemplateExpression(node)
  )
    return out;
  out.unprovable.push(`expression ${ts.SyntaxKind[node.kind]}`);
  return out;
}

function returnsOf(fn, ctx, depth, seen) {
  const out = { fields: new Set(), unprovable: [], nested: [] };
  fn = unwrapTs(fn);
  if (ts.isIdentifier(fn)) {
    const target = resolveFunction(fn, ctx);
    if (!target) {
      out.unprovable.push(`unresolved function ${fn.text}`);
      return out;
    }
    return returnsOf(target.node, target.ctx, depth, seen);
  }
  if (!ts.isFunctionLike(fn) || !fn.body) {
    out.unprovable.push('unresolved function');
    return out;
  }
  const exprs = [];
  if (!ts.isBlock(fn.body)) exprs.push(fn.body);
  else
    walk(fn.body, (n) => {
      if (ts.isReturnStatement(n) && n.expression) {
        let p = n.parent;
        while (p && !ts.isFunctionLike(p)) p = p.parent;
        if (p === fn) exprs.push(n.expression);
      }
    });
  for (const e of exprs) {
    const r = dataFields(e, ctx, depth + 1, seen);
    r.fields.forEach((f) => out.fields.add(f));
    out.unprovable.push(...r.unprovable);
    out.nested.push(...r.nested);
  }
  return out;
}

/** A function a callee names, in this file or in an enforced module it imports. */
function resolveFunction(callee, ctx) {
  callee = unwrapTs(callee);
  if (ts.isIdentifier(callee)) {
    const d = declarationOf(callee, ctx.ast);
    if (!d) return null;
    if (d.kind === 'function') return { node: d.node, ctx };
    if (
      d.kind === 'variable' &&
      d.node.initializer &&
      ts.isFunctionLike(unwrapTs(d.node.initializer))
    )
      return { node: unwrapTs(d.node.initializer), ctx };
    if (d.kind === 'import' || d.kind === 'import-default') {
      const imported = d.kind === 'import' ? (d.node.propertyName ?? d.node.name).text : 'default';
      const module = d.node.parent.parent.parent ?? d.node.parent;
      const spec = (ts.isImportDeclaration(module) ? module : d.node.parent.parent).moduleSpecifier
        ?.text;
      return ctx.project?.exported(ctx.local, spec, imported) ?? null;
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const d = declarationOf(callee.expression, ctx.ast);
    if (d?.kind === 'import-namespace') {
      const spec = d.node.parent.parent.moduleSpecifier.text;
      return ctx.project?.exported(ctx.local, spec, callee.name.text) ?? null;
    }
  }
  return null;
}

/** For a parameter of a local function: [ [argumentExpression, ctx] ] at each call site, or null. */
function callerArguments(d, identifier, ctx) {
  const fn = d.node.parent;
  if (!ts.isFunctionLike(fn)) return null;
  const index = fn.parameters.indexOf(d.node);
  if (index < 0 || ts.isBindingElement(d.node)) return null;
  // The declaration that names fn: `function f`, `const f = (…) =>`, or the
  // inner function of a curried `const f = (a) => (b) => …` (called as g(…)
  // where `const g = f(…)`, or f(…)(…)).
  let named = null;
  let curried = false;
  if (fn.name && ts.isIdentifier(fn.name)) named = fn;
  else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
    named = fn.parent;
  else if (
    ts.isArrowFunction(fn.parent) &&
    fn.parent.body === fn &&
    ts.isVariableDeclaration(fn.parent.parent) &&
    ts.isIdentifier(fn.parent.parent.name)
  ) {
    named = fn.parent.parent;
    curried = true;
  }
  if (!named) return null;
  const fnName = named.name.text;
  const declares = (callee) => {
    const target = ts.isIdentifier(callee) ? declarationOf(callee, ctx.ast) : null;
    return target && (target.node === named || target.node === fn);
  };
  const sites = [];
  const holders = new Set(); // variables bound to f(…) for a curried f
  walk(ctx.ast, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = unwrapTs(n.expression);
    if (
      !curried &&
      ts.isIdentifier(callee) &&
      callee.text === fnName &&
      declares(callee) &&
      n.arguments[index]
    )
      sites.push([n.arguments[index], ctx]);
    if (
      curried &&
      ts.isCallExpression(callee) &&
      ts.isIdentifier(unwrapTs(callee.expression)) &&
      declares(unwrapTs(callee.expression)) &&
      n.arguments[index]
    )
      sites.push([n.arguments[index], ctx]);
    if (
      curried &&
      ts.isIdentifier(callee) &&
      declares(callee) &&
      ts.isVariableDeclaration(n.parent) &&
      ts.isIdentifier(n.parent.name)
    )
      holders.add(n.parent);
  });
  if (curried)
    walk(ctx.ast, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(unwrapTs(n.expression))) return;
      const target = declarationOf(unwrapTs(n.expression), ctx.ast);
      if (target && holders.has(target.node) && n.arguments[index])
        sites.push([n.arguments[index], ctx]);
    });
  // An optional parameter that some caller omits takes its default.
  if (d.node.initializer) sites.push([d.node.initializer, ctx]);
  const exported =
    (!curried && ts.getCombinedModifierFlags(named) & ts.ModifierFlags.Export) ||
    (ts.isVariableDeclaration(named) &&
      ts.getCombinedModifierFlags(named.parent.parent) & ts.ModifierFlags.Export);
  if (exported) {
    const external = ctx.project?.callers(ctx.local, fnName, index);
    if (!external) return null;
    sites.push(...external);
  }
  return sites;
}

/** Delegate named by a Prisma model call receiver, null when not a delegate, or {dynamic}. */
function delegateOf(receiver, ctx, index) {
  receiver = unwrapTs(receiver);
  if (ts.isPropertyAccessExpression(receiver)) {
    const n = receiver.name.text;
    return index.delegates.has(n) ? { name: n } : { unknown: n };
  }
  if (ts.isElementAccessExpression(receiver)) {
    const key = constantText(receiver.argumentExpression);
    if (key === null) return { dynamic: true };
    return index.delegates.has(key) ? { name: key } : { unknown: key };
  }
  if (ts.isIdentifier(receiver)) {
    const d = declarationOf(receiver, ctx.ast);
    if (d?.kind === 'variable' && d.node.initializer)
      return delegateOf(d.node.initializer, ctx, index);
    return { unknown: receiver.text };
  }
  return { unknown: '?' };
}

function gatedFieldsOf(delegate, index) {
  return index.fieldsByDelegate.get(delegate) ?? new Set();
}

/** Check one data value flowing into `delegate` (or unknown/dynamic). */
function checkData(value, delegate, ctx, index, report, at, depth = 0) {
  const r = dataFields(value, ctx);
  const gatedHere = delegate?.name ? gatedFieldsOf(delegate.name, index) : index.fieldNames;
  const hit = [...r.fields].filter((f) => gatedHere.has(f));
  if (hit.length)
    report(
      at,
      `direct ORM eligibility write (${delegate?.name ?? 'model unknown'}.${hit.join(', ')})`,
    );
  const mayGate = delegate?.name ? gatedHere.size > 0 : true;
  if (r.unprovable.length && mayGate && (delegate?.name || delegate?.dynamic || hit.length === 0))
    report(
      at,
      `unprovable ORM data flow into ${delegate?.name ?? (delegate?.dynamic ? 'a dynamic model' : 'an unknown model')} (${r.unprovable[0]})`,
    );
  // Nested relation writes: data: { rel: { create: {...} } }.
  if (delegate?.name && depth < 3)
    for (const { field, value: v } of r.nested) {
      const related = index.relations.get(delegate.name)?.get(field);
      if (!related) continue;
      const inner = unwrapTs(v);
      if (!ts.isObjectLiteralExpression(inner)) {
        if (gatedFieldsOf(related, index).size)
          report(at, `unprovable ORM data flow into ${related} (relation ${field})`);
        continue;
      }
      for (const p of inner.properties)
        if (
          ts.isPropertyAssignment(p) &&
          ['create', 'createMany', 'connectOrCreate', 'upsert', 'update', 'updateMany'].includes(
            name(p.name, ctx.ast),
          )
        ) {
          const payload = unwrapTs(p.initializer);
          const data =
            ts.isObjectLiteralExpression(payload) &&
            ['createMany', 'connectOrCreate', 'upsert', 'update', 'updateMany'].includes(
              name(p.name, ctx.ast),
            )
              ? payload.properties
                  .filter((q) => ts.isPropertyAssignment(q) && DATA_KEYS.has(name(q.name, ctx.ast)))
                  .map((q) => q.initializer)
              : [payload];
          for (const dv of data)
            checkData(dv, { name: related }, ctx, index, report, at, depth + 1);
        }
    }
}

// ---------------------------------------------------------------------------
// Spliced table and column text: resolved statically, or refused.

/** Elements of an array that is a literal (or a const bound to one), else null. */
function arrayElements(expression, ctx, depth = 0) {
  const node = unwrapTs(expression);
  if (!node || depth > 4) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const e of node.elements) {
      if (!ts.isSpreadElement(e)) out.push(e);
      else {
        const inner = arrayElements(e.expression, ctx, depth + 1);
        if (!inner) return null;
        out.push(...inner);
      }
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    const d = declarationOf(node, ctx.ast);
    if (
      d?.kind === 'variable' &&
      d.node.parent.flags & ts.NodeFlags.Const &&
      d.node.initializer &&
      !mutated(d, ctx)
    )
      return arrayElements(d.node.initializer, ctx, depth + 1);
  }
  return null;
}

const MUTATORS = new Set(['push', 'unshift', 'splice', 'fill', 'copyWithin', 'set']);
/**
 * May the const array or object `d` declares change after its initializer?
 * A mutator call on it, a property/element assignment or delete, Object.assign
 * or defineProperty on it, or handing it to any function (which might mutate
 * it) all count: its literal elements are then not its whole content.
 */
const mutatedMemo = new WeakMap();
function mutated(d, ctx) {
  if (mutatedMemo.has(d.node)) return mutatedMemo.get(d.node);
  const result = mutatedUncached(d, ctx);
  mutatedMemo.set(d.node, result);
  return result;
}
function mutatedUncached(d, ctx) {
  let found = false;
  const same = (n) =>
    ts.isIdentifier(n) && n.text === d.node.name.text && declarationOf(n, ctx.ast) === d;
  walk(d.scope ?? ctx.ast, (n) => {
    if (found || !same(n)) return;
    // `o.name` and `{ name: v }` name a property, not the binding.
    if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
    if (ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
    let ref = n;
    let p = n.parent;
    while (
      p &&
      (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p))
    ) {
      ref = p;
      p = p.parent;
    }
    if (
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === ref
    ) {
      const q = p.parent;
      if (
        ts.isPropertyAccessExpression(p) &&
        MUTATORS.has(p.name.text) &&
        ts.isCallExpression(q) &&
        q.expression === p
      )
        found = true;
      else if (
        ts.isBinaryExpression(q) &&
        q.left === p &&
        q.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        q.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      )
        found = true;
      else if (ts.isDeleteExpression(q)) found = true;
      return;
    }
    if (ts.isCallExpression(p) && p.arguments.includes(ref)) {
      const callee = p.expression.getText(ctx.ast);
      // Functions that only read their argument.
      if (
        !/^(?:Object\.(?:keys|values|entries|freeze)|Array\.isArray|JSON\.stringify|String|Number)$|(?:^|\.)each$/.test(
          callee,
        )
      )
        found = true;
    }
  });
  return found;
}

/** Property values of a const object literal, or null. */
function constObjectValues(identifier, ctx) {
  const d = declarationOf(identifier, ctx.ast);
  const init =
    d?.kind === 'variable' && d.node.parent.flags & ts.NodeFlags.Const && !mutated(d, ctx)
      ? unwrapTs(d.node.initializer)
      : null;
  if (!init || !ts.isObjectLiteralExpression(init)) return null;
  const out = [];
  for (const p of init.properties) {
    if (!ts.isPropertyAssignment(p)) return null;
    out.push(p.initializer);
  }
  return out;
}

/** Keys of a const object literal as string-literal-like nodes, or null. */
function constObjectKeys(identifier, ctx) {
  const d = declarationOf(identifier, ctx.ast);
  const init =
    d?.kind === 'variable' && d.node.parent.flags & ts.NodeFlags.Const && !mutated(d, ctx)
      ? unwrapTs(d.node.initializer)
      : null;
  if (!init || !ts.isObjectLiteralExpression(init)) return null;
  const out = [];
  for (const p of init.properties) {
    if (!ts.isPropertyAssignment(p)) return null;
    const key = name(p.name, ctx.ast);
    if (key === '${value}') return null;
    out.push(ts.factory.createStringLiteral(key));
  }
  return out;
}

/**
 * Expressions a binding element can hold, from `const [a, b] = X`, `const {a} = X`
 * or `for (const [k, [v]] of Object.entries(CONST))`. [null] when unknown.
 */
function bindingSources(element, ctx) {
  const path = [];
  let n = element;
  while (ts.isBindingElement(n)) {
    const pattern = n.parent;
    path.unshift(
      ts.isArrayBindingPattern(pattern)
        ? { index: pattern.elements.indexOf(n) }
        : { key: (n.propertyName ?? n.name).getText(ctx.ast) },
    );
    n = pattern.parent;
  }
  if (!ts.isVariableDeclaration(n)) return [null];
  let sources;
  const list = n.parent;
  const statement = list?.parent;
  if (statement && ts.isForOfStatement(statement) && statement.initializer === list) {
    const iter = unwrapTs(statement.expression);
    if (
      ts.isCallExpression(iter) &&
      iter.expression.getText(ctx.ast) === 'Object.entries' &&
      ts.isIdentifier(unwrapTs(iter.arguments[0]))
    ) {
      const keys = constObjectKeys(unwrapTs(iter.arguments[0]), ctx);
      const values = constObjectValues(unwrapTs(iter.arguments[0]), ctx);
      if (!keys || !values) return [null];
      const first = path.shift();
      if (!first || first.index === undefined) return [null];
      sources = first.index === 0 ? keys : first.index === 1 ? values : [null];
    } else {
      const elements = arrayElements(iter, ctx);
      sources = elements ?? [null];
    }
  } else if (n.initializer) {
    const init = unwrapTs(n.initializer);
    if (ts.isElementAccessExpression(init) && ts.isIdentifier(unwrapTs(init.expression)))
      sources = constObjectValues(unwrapTs(init.expression), ctx) ?? [null];
    else sources = [init];
  } else return [null];
  for (const step of path) {
    sources = sources.flatMap((src) => {
      const v = src && unwrapTs(src);
      if (!v) return [null];
      if (step.index !== undefined && ts.isArrayLiteralExpression(v))
        return [v.elements[step.index] ?? null];
      if (step.key !== undefined && ts.isObjectLiteralExpression(v)) {
        const p = v.properties.find(
          (q) => ts.isPropertyAssignment(q) && name(q.name, ctx.ast) === step.key,
        );
        return [p ? p.initializer : null];
      }
      return [null];
    });
  }
  return sources;
}

/** Values a parameter takes: local call sites, or the rows of an it.each/test.each table. */
function parameterValues(d, ctx) {
  const fn = d.node.parent;
  if (!ts.isFunctionLike(fn) || ts.isBindingElement(d.node)) return null;
  const index = fn.parameters.indexOf(d.node);
  const call = fn.parent;
  if (
    call &&
    ts.isCallExpression(call) &&
    call.arguments.includes(fn) &&
    ts.isCallExpression(call.expression)
  ) {
    const each = call.expression;
    if (/(?:^|\.)each$/.test(each.expression.getText(ctx.ast)) && each.arguments[0]) {
      const rows = arrayElements(each.arguments[0], ctx);
      if (!rows) return null;
      const out = [];
      for (const row of rows) {
        const r = unwrapTs(row);
        const cells = ts.isArrayLiteralExpression(r) ? r.elements : index === 0 ? [r] : null;
        if (!cells || !cells[index]) return null;
        out.push([cells[index], ctx]);
      }
      return out;
    }
  }
  return callerArguments(d, d.node.name, ctx);
}

/** Candidate SQL texts for a spliced expression: [{text, spans, reviewed}] or null. */
function candidates(expression, ctx, isReviewed, depth = 0) {
  const node = unwrapTs(expression);
  if (!node || depth > 6) return null;
  const again = (n, c = ctx) => candidates(n, c, isReviewed, depth + 1);
  const union = (lists) => (lists.some((l) => l === null) ? null : lists.flat());
  if (ts.isTaggedTemplateExpression(node)) {
    if (!isReviewed.tag(node, ctx)) return null;
    return [
      {
        ...composeTagged(node.template, ctx.ast),
        reviewed: isReviewed.template(node.template, ctx),
      },
    ];
  }
  if (ts.isNumericLiteral(node)) return [{ text: node.text, spans: [], reviewed: false }];
  // <provable list>.join(sep), e.g. Object.keys(row).map((c) => `"${c}"`).join(', ').
  const joined = joinedText(node, ctx, isReviewed);
  if (joined !== undefined)
    return joined === null ? null : [{ text: joined, spans: [], reviewed: false }];
  if (isSqlish(node)) {
    const composed = composeSql(node, ctx.ast);
    // Splices inside a candidate resolve the same way.
    let lists = [[{ text: composed.text, spans: [], reviewed: false }]];
    for (const [i, span] of composed.spans.entries()) {
      const inner = again(span);
      if (!inner) return [{ text: composed.text, spans: composed.spans, reviewed: false }];
      lists = [
        lists.flat().flatMap((c) =>
          inner.map((x) => ({
            ...c,
            text: c.text.replace(PLACEHOLDER(i), x.text),
            reviewed: c.reviewed || x.reviewed,
          })),
        ),
      ];
      if (lists[0].length > 256) return null;
    }
    return lists.flat();
  }
  if (ts.isConditionalExpression(node)) return union([again(node.whenTrue), again(node.whenFalse)]);
  // CONST[key]: any value of a const object literal (sound over-approximation).
  if (ts.isElementAccessExpression(node) && ts.isIdentifier(unwrapTs(node.expression))) {
    const values = constObjectValues(unwrapTs(node.expression), ctx);
    if (values) return union(values.map((v) => again(v)));
  }
  if (ts.isIdentifier(node)) {
    const d = declarationOf(node, ctx.ast);
    if (!d) return null;
    if (d.kind === 'binding')
      return union(bindingSources(d.node, ctx).map((v) => (v === null ? null : again(v))));
    if (d.kind === 'variable') {
      const list = d.node.parent;
      const statement = list?.parent;
      if (statement && ts.isForOfStatement(statement) && statement.initializer === list) {
        const elements = arrayElements(statement.expression, ctx);
        return elements ? union(elements.map((e) => again(e))) : null;
      }
      if (list.flags & ts.NodeFlags.Const && d.node.initializer) return again(d.node.initializer);
      return null;
    }
    if (d.kind === 'parameter') {
      const values = parameterValues(d, ctx);
      return values ? union(values.map(([arg, c]) => again(arg, c))) : null;
    }
  }
  return null;
}

/**
 * A list of strings an expression provably is: Object.keys(<object with provable
 * keys>), an array literal of candidates, a const bound to one, or
 * `<list>.map((x) => <template of x>)`. null when not provable.
 */
function stringList(expression, ctx, isReviewed, depth = 0) {
  const node = unwrapTs(expression);
  if (!node || depth > 5) return null;
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ctx.ast) === 'Object.keys' &&
    node.arguments[0]
  ) {
    const fields = dataFields(node.arguments[0], ctx);
    return fields.unprovable.length ? null : [...fields.fields];
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'map'
  ) {
    const list = stringList(node.expression.expression, ctx, isReviewed, depth + 1);
    const cb = unwrapTs(node.arguments[0]);
    if (!list || !cb || !ts.isFunctionLike(cb) || ts.isBlock(cb.body) || !cb.parameters.length)
      return null;
    const param = cb.parameters[0].name;
    const body = unwrapTs(cb.body);
    const out = [];
    for (const [i, item] of list.entries()) {
      const text = mapText(body, param, item, i, cb.parameters[1]?.name);
      if (text === null) return null;
      out.push(text);
    }
    return out;
  }
  const elements = arrayElements(node, ctx);
  if (elements) {
    const out = [];
    for (const e of elements) {
      const c = candidates(e, ctx, isReviewed, depth + 1);
      if (!c || c.length !== 1) return null;
      out.push(c[0].text);
    }
    return out;
  }
  if (ts.isIdentifier(node)) {
    const d = declarationOf(node, ctx.ast);
    if (
      d?.kind === 'variable' &&
      d.node.parent.flags & ts.NodeFlags.Const &&
      d.node.initializer &&
      !mutated(d, ctx)
    )
      return stringList(d.node.initializer, ctx, isReviewed, depth + 1);
  }
  return null;
}

/** The text of a .map() callback body for one element (the parameter and index only). */
function mapText(body, param, item, i, indexParam) {
  const value = (n) => {
    n = unwrapTs(n);
    if (ts.isIdentifier(n) && ts.isIdentifier(param) && n.text === param.text) return item;
    if (
      ts.isIdentifier(n) &&
      indexParam &&
      ts.isIdentifier(indexParam) &&
      n.text === indexParam.text
    )
      return String(i);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const [l, r] = [value(n.left), value(n.right)];
      return l === null || r === null ? null : l + r;
    }
    if (ts.isNumericLiteral(n)) return n.text;
    if (ts.isStringLiteralLike(n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text;
      for (const span of n.templateSpans) {
        const v = value(span.expression);
        if (v === null) return null;
        out += v + span.literal.text;
      }
      return out;
    }
    return null;
  };
  return value(body);
}

/** `<list>.join(sep)` of a provable string list, else undefined (not this shape) or null. */
function joinedText(node, ctx, isReviewed) {
  if (!(
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'join'
  ))
    return undefined;
  if (ts.isArrayLiteralExpression(unwrapTs(node.expression.expression))) return undefined; // composeSql reads literal arrays
  const sep = node.arguments[0] ? constantText(node.arguments[0]) : ',';
  const list = stringList(node.expression.expression, ctx, isReviewed);
  return sep === null || !list ? null : list.join(sep);
}

/** Placeholder numbers in table or column position of a statement text. */
function columnPlaceholders(text) {
  const a = analyse(text, () => 'unknown');
  const out = new Set();
  for (const w of a.writes) {
    if (w.kind === 'set-fragment') out.add(Number(a.tokens[w.op].value));
    else if (w.dynamic && w.range)
      for (let k = w.range[0]; k <= w.range[1]; k += 1)
        if (a.tokens[k]?.type === 'placeholder') out.add(Number(a.tokens[k].value));
  }
  for (const r of a.tables)
    if (r.dynamic && Number.isInteger(r.placeholder)) out.add(r.placeholder);
  return [...out];
}

/**
 * Findings for a composed statement after resolving its spliced table/column
 * text. `reviewed`: the statement is a reviewed probe, so its STATIC gated
 * writes are allowed, and a splice may add one only if it is a reviewed
 * fragment itself.
 */
function resolvedFindings(composed, ctx, index, isReviewed, reviewed) {
  const base = sqlWriteFindings(composed.text, index);
  const direct = (fs) => fs.filter((f) => f.startsWith('direct'));
  const positions = columnPlaceholders(composed.text);
  if (!positions.length || !base.some((f) => f.startsWith('unclassified')))
    return reviewed ? [] : base;
  const out = reviewed ? [] : direct(base);
  for (const p of positions) {
    const cands = candidates(composed.spans[p], ctx, isReviewed);
    if (!cands) {
      out.push(
        `unclassified SQL write columns: splice \${${composed.spans[p].getText(ctx.ast).slice(0, 40)}} cannot be resolved statically`,
      );
      continue;
    }
    const stat = new Set(direct(base));
    for (const cand of cands) {
      const text = composed.text.replace(
        PLACEHOLDER(p),
        cand.text.replaceAll('\uE000', '\uE000900'),
      );
      const found = sqlWriteFindings(text, index);
      const added = direct(found).filter((f) => !stat.has(f));
      if (added.length && !(reviewed && cand.reviewed))
        out.push(...added.map((f) => `${f} via splice`));
      const nested = columnPlaceholders(text).filter((n) => n >= 900);
      if (nested.length)
        out.push(`unclassified SQL write columns: nested splice in a resolved column list`);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Per-file check.

const TAGS = ['eligibilityClockSql', 'eligibilityClockWrite', 'eligibilityClockTag'];

export function hazards(
  source,
  file,
  index,
  reviewed = [],
  signatures = new Map(),
  project = null,
) {
  const errors = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) return [`${file}:1: unparseable test source`];
  const ctx = { local: file, ast, project };
  const report = (node, reason) => errors.push(`${file}:${lineOf(ast, node)}: ${reason}`);
  const variables = new Map();
  walk(ast, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      variables.set(node.name.text, node.initializer);
  });
  // Helper tags imported from @rasta/testing (or the helper file itself), unshadowed.
  const tags = new Map();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = statement.moduleSpecifier.text;
    if (
      spec !== '@rasta/testing' &&
      !/(?:^|\/)packages\/testing\/src\/eligibility-clock(?:\.ts)?$/.test(spec)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements)
        tags.set(item.name.text, (item.propertyName ?? item.name).text);
  }
  walk(ast, (node) => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      tags.has(node.name.getText(ast))
    )
      tags.delete(node.name.getText(ast));
  });
  const reviewedHere = reviewed.filter((r) => r.file === file);
  const isReviewed = {
    tag: (tagged) =>
      TAGS.includes(
        tags.get(
          ts.isCallExpression(tagged.tag)
            ? tagged.tag.expression.getText(ast)
            : tagged.tag.getText(ast),
        ),
      ),
    template: (template) => {
      const hash = templateHash(template);
      const exprs = ts.isTemplateExpression(template) ? expressionHash(template, ast) : null;
      return reviewedHere.some((r) => r.template === hash && r.expressions === exprs);
    },
  };

  walk(ast, (node) => {
    // Zero lease/backoff options and positional leases.
    if (
      ts.isPropertyAssignment(node) &&
      /^(?:(?:.*lease|.*backoff|.*delay).*Seconds|baseSeconds)$/i.test(name(node.name, ast)) &&
      zero(node.initializer)
    )
      report(node, 'zero lease/backoff option');
    if (ts.isCallExpression(node)) {
      const method = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isElementAccessExpression(node.expression)
          ? name(node.expression.argumentExpression, ast)
          : name(node.expression, ast);
      const indices =
        signatures.get(method) ??
        (method === 'claimDue'
          ? new Set([1])
          : /^(claim|claimPending|claimSendable|claimReady|claimBatch)$/.test(method)
            ? new Set([2])
            : new Set());
      if (
        [...indices].some(
          (i) =>
            zero(node.arguments[i]) ||
            (ts.isIdentifier(node.arguments[i] ?? {}) &&
              zero(variables.get(node.arguments[i].text))),
        )
      )
        report(node, 'zero positional lease');
    }

    // ORM: Prisma-shaped write calls.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrapTs(node.expression))) {
      const callee = unwrapTs(node.expression);
      const method = callee.name.text;
      const args = node.arguments[0] ? unwrapTs(node.arguments[0]) : null;
      let argsObject = args;
      if (args && ts.isIdentifier(args)) {
        const d = declarationOf(args, ast);
        if (
          d?.kind === 'variable' &&
          d.node.initializer &&
          ts.isObjectLiteralExpression(unwrapTs(d.node.initializer))
        )
          argsObject = unwrapTs(d.node.initializer);
      }
      const dataProps =
        argsObject && ts.isObjectLiteralExpression(argsObject)
          ? argsObject.properties.filter(
              (p) =>
                (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                DATA_KEYS.has(name(p.name, ast)),
            )
          : [];
      const spreadArgs =
        argsObject &&
        ts.isObjectLiteralExpression(argsObject) &&
        argsObject.properties.some((p) => ts.isSpreadAssignment(p));
      if (
        !ASSERTIONS.test(callee.getText(ast)) &&
        (PRISMA_WRITES.has(method) || dataProps.length)
      ) {
        const delegate = delegateOf(callee.expression, ctx, index);
        const isDelegate = Boolean(delegate.name || delegate.dynamic);
        // A model delegate (or a dynamic one), or an unknown receiver of a Prisma write method.
        if (isDelegate || (PRISMA_WRITES.has(method) && dataProps.length)) {
          for (const p of dataProps)
            checkData(
              ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer,
              delegate.name || delegate.dynamic ? delegate : null,
              ctx,
              index,
              report,
              p,
            );
          if (
            isDelegate &&
            PRISMA_WRITES.has(method) &&
            args &&
            !dataProps.length &&
            (!ts.isObjectLiteralExpression(argsObject ?? {}) || spreadArgs) &&
            (delegate.dynamic || gatedFieldsOf(delegate.name, index).size)
          )
            report(
              node,
              `unprovable ORM data flow into ${delegate.name ?? 'a dynamic model'} (arguments)`,
            );
        }
      }
    }

    // Object literals carrying a gated field handed to a function: follow it.
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          index.fieldNames.has(name(p.name, ast)),
      )
    ) {
      const sink = argumentSink(node, ast);
      if (sink) {
        const callee = unwrapTs(sink.call.expression);
        const text = callee.getText(ast);
        if (
          !ASSERTIONS.test(text) &&
          !/^(?:expect|assert|it|test|describe|jest\.fn|console\.\w+|JSON\.stringify)/.test(text)
        ) {
          const fields = node.properties
            .filter(
              (p) =>
                (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                index.fieldNames.has(name(p.name, ast)),
            )
            .map((p) => name(p.name, ast));
          const target = resolveFunction(callee, ctx);
          if (target) {
            const reached = project?.paramReachesPrisma(target, sink.index);
            if (reached === null)
              report(
                node,
                `gated field ${fields.join(', ')} handed to a helper whose data flow cannot be followed`,
              );
          } else if (ts.isIdentifier(callee) && !isExternalOrProduction(callee, ctx)) {
            report(
              node,
              `gated field ${fields.join(', ')} handed to an unresolvable function ${text}`,
            );
          }
        }
      }
    }

    // SQL.
    if (!(
      ts.isStringLiteralLike(node) ||
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node) ||
      ts.isCallExpression(node)
    ))
      return;
    if (!sqlRoot(node)) return;
    if (ts.isTaggedTemplateExpression(node.parent) && node.parent.template === node) {
      const tag = node.parent.tag;
      const binding = tags.get(
        ts.isCallExpression(tag) ? tag.expression.getText(ast) : tag.getText(ast),
      );
      if (TAGS.includes(binding)) {
        const hash = templateHash(node);
        const exprs = expressionHash(node, ast);
        project?.liveTemplates.add(
          `${file}|${hash}|${ts.isTemplateExpression(node) ? exprs : null}`,
        );
        if (!isReviewed.template(node, ctx)) {
          report(
            node,
            'unreviewed eligibility SQL probe (template, file or substitutions not reviewed)',
          );
          return;
        }
        // F4: a reviewed probe may not write a gated column chosen at run time.
        for (const finding of resolvedFindings(
          composeTagged(node, ast),
          ctx,
          index,
          isReviewed,
          true,
        ))
          report(node, finding);
        return;
      }
    }
    const composed = ts.isTaggedTemplateExpression(node.parent)
      ? composeTagged(node, ast)
      : composeSql(node, ast);
    for (const finding of resolvedFindings(composed, ctx, index, isReviewed, false))
      report(node, finding);
  });
  return [...new Set(errors)];
}

function composeTagged(node, ast) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, spans: [] };
  return {
    text:
      node.head.text + node.templateSpans.map((s, i) => PLACEHOLDER(i) + s.literal.text).join(''),
    spans: node.templateSpans.map((s) => s.expression),
    ast,
  };
}

/** If `node` is (directly, or via a const binding) an argument of a call: {call, index}. */
function argumentSink(node, ast) {
  let target = node;
  let parent = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    target = parent;
    parent = parent.parent;
  }
  if (parent && ts.isCallExpression(parent) && parent.arguments.includes(target))
    return { call: parent, index: parent.arguments.indexOf(target) };
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    let found = null;
    walk(ast, (n) => {
      if (found || !ts.isCallExpression(n)) return;
      const i = n.arguments.findIndex(
        (a) => ts.isIdentifier(unwrapTs(a)) && unwrapTs(a).text === parent.name.text,
      );
      if (i >= 0) found = { call: n, index: i };
    });
    return found;
  }
  return null;
}

function isExternalOrProduction(identifier, ctx) {
  const d = declarationOf(identifier, ctx.ast);
  if (!d) return true; // a global
  if (d.kind === 'import' || d.kind === 'import-default' || d.kind === 'import-namespace') {
    let p = d.node;
    while (p && !ts.isImportDeclaration(p)) p = p.parent;
    const spec = p.moduleSpecifier.text;
    return ctx.project ? !ctx.project.isEnforcedImport(ctx.local, spec) : true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repository.

/** The helper module is the one allowed write path; its SQL must be static. */
export const HELPER = 'packages/testing/src/eligibility-clock.ts';
// The guard and its self-test hold refusal fixtures as data; they open no database.
const GUARD_FILES = [
  'scripts/eligibility-clock-guard.mjs',
  'scripts/eligibility-clock-sql.mjs',
  'scripts/eligibility-clock-derive.mjs',
  'scripts/eligibility-clock-scope.mjs',
  'scripts/outbox-test-clock.test.mjs',
];

export function helperHazards(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors = [];
  walk(ast, (node) => {
    if (!ts.isTemplateExpression(node) || ts.isTaggedTemplateExpression(node.parent)) return;
    const text = node.head.text + node.templateSpans.map((s) => s.literal.text).join('');
    if (/\b(?:update|insert|set|copy)\b/i.test(text))
      errors.push(
        `${file}:${lineOf(ast, node)}: helper SQL must be a static literal (no substitutions)`,
      );
  });
  return errors;
}

/**
 * The project view for cross-file flow: exported functions of enforced
 * modules, their callers, and whether a parameter reaches a Prisma write.
 */
export function createProject(repository, s) {
  const asts = new Map();
  const astOf = (local) => {
    if (!asts.has(local))
      asts.set(
        local,
        s.cache.get(local)?.ast ??
          ts.createSourceFile(
            local,
            readFileSync(join(repository, local), 'utf8'),
            ts.ScriptTarget.Latest,
            true,
          ),
      );
    return asts.get(local);
  };
  const resolveEdge = (from, spec) =>
    s.cache.get(from)?.edges.find((e) => e.specifier === spec)?.resolved ?? null;
  const project = {
    liveTemplates: new Set(),
    isEnforcedImport(from, spec) {
      const target = resolveEdge(from, spec);
      return Boolean(target && s.enforced.has(target));
    },
    exported(from, spec, nameWanted, depth = 0) {
      const target = resolveEdge(from, spec);
      if (!target || !s.enforced.has(target) || depth > 4) return null;
      const ast = astOf(target);
      let found = null;
      walk(ast, (n) => {
        if (found) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === nameWanted && n.body)
          found = { node: n, ctx: { local: target, ast, project } };
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === nameWanted &&
          n.initializer &&
          ts.isFunctionLike(unwrapTs(n.initializer))
        )
          found = { node: unwrapTs(n.initializer), ctx: { local: target, ast, project } };
      });
      if (found) return found;
      // Re-exports: export { x } from './y' / export * from './y'.
      for (const st of ast.statements)
        if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
          const named =
            st.exportClause && ts.isNamedExports(st.exportClause)
              ? st.exportClause.elements.find((e) => e.name.text === nameWanted)
              : null;
          if (named || !st.exportClause) {
            const r = project.exported(
              target,
              st.moduleSpecifier.text,
              named ? (named.propertyName ?? named.name).text : nameWanted,
              depth + 1,
            );
            if (r) return r;
          }
        }
      return null;
    },
    callers(local, fnName, argIndex) {
      // Callers of an exported function across enforced files that import it.
      const out = [];
      for (const other of s.enforced) {
        const result = s.cache.get(other);
        if (!result?.edges.some((e) => e.resolved === local)) continue;
        const ast = astOf(other);
        walk(ast, (n) => {
          if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === fnName &&
            n.arguments[argIndex]
          )
            out.push([n.arguments[argIndex], { local: other, ast, project }]);
        });
      }
      return out;
    },
    // Does parameter `i` of a helper reach Prisma data? false = provably not; null = cannot follow.
    paramReachesPrisma(target, i) {
      const param = target.node.parameters?.[i];
      if (!param) return false;
      return ts.isIdentifier(param.name) || ts.isObjectBindingPattern(param.name) ? false : null;
    },
  };
  return project;
}

export function repositoryHazards(repository, options = {}) {
  const gate = options.gate ?? deriveGate(repository);
  const index = options.index ?? gateIndex(gate);
  const reviewed = options.reviewed ?? reviewedTemplates(repository);
  const signatures = options.signatures ?? leaseSignatures(repository, gate.flow);
  const s = options.scope ?? testScope(repository, undefined, options.reviewedImports);
  const project = createProject(repository, s);
  const errors = [...s.refusals];
  for (const local of [...s.enforced].sort()) {
    if (GUARD_FILES.includes(local)) continue;
    const source = readFileSync(join(repository, local), 'utf8');
    if (local === HELPER) errors.push(...helperHazards(source, local));
    else errors.push(...hazards(source, local, index, reviewed, signatures, project));
  }
  // A reviewed entry that no live template in its file matches is stale.
  for (const entry of reviewed)
    if (!project.liveTemplates.has(`${entry.file}|${entry.template}|${entry.expressions}`))
      errors.push(
        `${HELPER}:1: stale reviewed template for ${entry.file} (${entry.template.slice(0, 12)})`,
      );
  for (const local of s.sqlFixtures)
    for (const finding of sqlWriteFindings(readFileSync(join(repository, local), 'utf8'), index))
      errors.push(`${local}:1: ${finding}`);
  return errors;
}
export const __debug = { dataFields, stringList, candidates, declarationOf };
