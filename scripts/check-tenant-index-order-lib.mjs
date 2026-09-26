/**
 * Every composite index on a tenant-owned table leads with `organization_id`
 * (ADR-011 § Consequences, docs/05 § rules; audit finding L7-44).
 *
 * The tenant guard adds `organization_id = $1` to every query on a guarded
 * model, so an index whose first column is something else serves that query
 * only by accident of selectivity. The rule is written down; this is what makes
 * it true of the schema rather than of the reviews somebody remembered.
 *
 * What "the schema" means here is what PostgreSQL ends up holding, not what
 * `schema.prisma` declares: partial unique indexes (`WHERE state = 'OPEN'`)
 * cannot be written in Prisma and exist only in migration SQL. So the check
 * replays each service's `migration.sql` files in order — CREATE TABLE,
 * PRIMARY KEY and UNIQUE constraints (including ADD CONSTRAINT ... USING
 * INDEX, which adopts a prebuilt index), CREATE/DROP/ALTER INDEX — and judges the
 * final state.
 *
 * Some composite indexes legitimately lead with something else, and each is
 * named in `EXEMPTIONS` with the reason. The categories are few:
 *
 *   - a cross-tenant path that exists by design (a worker that claims due rows
 *     for every tenant, a platform-scope read under `runUnscoped`): leading with
 *     `organization_id` would make the index useless to the only query it has;
 *   - a parent-child path: Prisma loads an `include`d relation with
 *     `WHERE parent_id IN (...)` and no organization predicate, and PostgreSQL
 *     checks an `ON DELETE RESTRICT` foreign key the same way;
 *   - an invariant scoped to a parent row (one open suspension per supplier):
 *     the parent already belongs to exactly one tenant, and widening the key
 *     with `organization_id` would only weaken it;
 *   - a partitioned table, where PostgreSQL requires the partition key in
 *     every unique index.
 *
 * An exemption that names no existing index, or an index that already
 * complies, is itself an error: a stale exemption is a hole waiting for the
 * next index to reuse its name.
 *
 * Pure apart from `readMigrationTexts`: text in, problems out. No database,
 * no Prisma.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const TENANT_COLUMN = 'organization_id';

/** Services whose schemas this check owns. Others opt in as their owners adopt it. */
export const SERVICES = ['supplier', 'notification', 'document', 'audit', 'construction'];

/**
 * Tables that carry `organization_id` but are platform plumbing, not tenant
 * data: the outbox is written in the request's transaction and drained by a
 * relay with no request context, for every tenant at once. Every service makes
 * the same exception in `TENANT_SCOPE_EXEMPT_MODELS`.
 */
export const EXEMPT_TABLES = {
  outbox_message: 'transactional outbox, drained across tenants by the relay (ADR-021, ADR-050)',
};

const PARENT_LOAD =
  'parent-child path: Prisma loads the relation by the parent id with no organization ' +
  'predicate, and the ON DELETE RESTRICT check probes it the same way';

/**
 * Why a per-parent unique must not gain a leading organization_id: the child
 * table references its parent by id alone, so nothing in the database makes a
 * child's organization_id equal its parent's. Keyed on (organization_id,
 * parent_id, …), two rows for one parent that disagree on organization_id
 * would both be accepted, and the invariant would stop holding.
 */
const perParentUnique = (fk) =>
  `leading with organization_id would weaken it: the foreign key is on ${fk} alone, so two rows ` +
  `for one parent with different organization_id would both be accepted`;

/** `service` → index or constraint name → why it does not lead with organization_id. */
export const EXEMPTIONS = {
  supplier: {
    ux_supplier_capability: `one row per (supplier, capability) — an invariant of one supplier; ${perParentUnique('supplier_id')}; ${PARENT_LOAD}`,
    ux_qualification_open: `at most one open submission per (supplier, capability) — an invariant of one supplier; ${perParentUnique('supplier_id')}`,
    ux_qualification_approved: `at most one approval per (supplier, capability) — an invariant of one supplier; ${perParentUnique('supplier_id')}`,
    ix_qualification_supplier_state: PARENT_LOAD,
    ix_qualification_review_queue:
      'the platform review queue (SupplierRepository.listForReview) is cross-tenant under runUnscoped',
    ux_qualification_evidence_document: `one row per (qualification, document) — an invariant of one qualification; ${perParentUnique('qualification_id')}; ${PARENT_LOAD}`,
    ix_suspension_supplier: `${PARENT_LOAD}; also the open-episode lookup, which names the supplier`,
  },
  notification: {
    ux_resolution_intent_user: `one resolution per (intent, user) — an invariant of one intent; the mail worker joins on it across tenants; ${perParentUnique('intent_id')}`,
    ux_delivery_intent_user_channel: `one delivery per (intent, user, channel) — an invariant of one intent; ${perParentUnique('intent_id')}`,
    ix_delivery_channel_status_next: 'the delivery workers claim due rows for every tenant at once',
    ix_delivery_sendable: 'the mail worker claims sendable rows for every tenant at once',
    ux_attempt_delivery_no: `one row per (delivery, attempt number) — an invariant of one delivery; ${perParentUnique('delivery_id')}`,
  },
  document: {
    uq_grant_document_subject: `one grant per (document, subject) — an invariant of one document; ${perParentUnique('document_id')}`,
    ix_document_scan_queue: 'the scan worker claims queued documents for every tenant at once',
  },
  // construction: every child references its parent by (organization_id,
  // parent_id), so per-parent indexes lead with the tenant column without
  // weakening anything. One exemption:
  construction: {
    ix_approval_authority_inbox:
      "the authority's inbox (GET /v1/approvals): an approval belongs to the project's organization, but the authority asking is another tenant, whose organization is authority_organization_id — the column this index leads with",
  },
  audit: {
    audit_event_pkey:
      'audit_event is partitioned by occurred_at, and PostgreSQL requires the partition key in every unique index',
    audit_event_source_identity_key:
      'consumer idempotency on a partitioned table: the partition key must lead the unique index',
    audit_event_resource_idx:
      'serves platform-scope search (ADR-053 § 10) as well as tenant search; tenant search has audit_event_org_time_idx',
    audit_event_topic_time_idx: 'operational replay by source topic, across tenants',
    audit_event_correction_idx:
      'the correctedBy probe is keyed by the corrected record id, whose scope was checked when that record was read',
    audit_chain_head_pkey:
      'chain_scope separates the platform chain (organization_id = empty string) from tenant chains; lookups name all three columns',
    audit_chain_head_month_idx: 'which chains a month holds — asked across tenants by verification',
  },
};

/** Every `migration.sql` under a Prisma migrations directory, in apply order. */
export function readMigrationTexts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(dir, name, 'migration.sql'))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// SQL scanning
// ---------------------------------------------------------------------------

/**
 * Removes comments, dollar-quoted bodies and string literals, so that a
 * `CREATE INDEX` inside a comment, a function body or an `EXECUTE format(...)`
 * string is not mistaken for DDL. What remains keeps its length-independent
 * structure: identifiers, keywords and parentheses.
 */
export function stripNonDdl(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      out += " '' ";
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      i = j + 1;
      out += " '' ";
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;

function unquote(identifier) {
  const trimmed = identifier.trim();
  return trimmed.startsWith('"') ? trimmed.slice(1, -1) : trimmed.toLowerCase();
}

/** The text between the parenthesis at `open` and its partner. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  throw new Error(`unbalanced parenthesis at offset ${open}`);
}

/** Splits on top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The first key column of an index element list: a column name, or `(expression)`. */
function keyColumns(list) {
  return splitTopLevel(list).map((element) => {
    const match = new RegExp(`^(${IDENT})`).exec(element);
    return match && !element.startsWith('(') ? unquote(match[1]) : `(${element})`;
  });
}

/**
 * Replays migrations into `{ tables, indexes }`:
 *   tables:  Map<table, Set<column>>
 *   indexes: Map<name, { table, columns: string[], unique: boolean, kind }>
 */
export function replayMigrations(sqlTexts) {
  const tables = new Map();
  const indexes = new Map();

  for (const raw of sqlTexts) {
    const sql = stripNonDdl(raw);

    // Statements are applied in textual order, so collect every match with its
    // offset and sort, rather than running each pattern over the whole file.
    const events = [];
    const push = (re, kind) => {
      for (const match of sql.matchAll(re)) events.push({ at: match.index, kind, match });
    };
    push(
      new RegExp(
        String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}\s*\(`,
        'gi',
      ),
      'createTable',
    );
    push(new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}`, 'gi'), 'dropTable');
    push(
      new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+RENAME\s+TO\s+(${IDENT})`,
        'gi',
      ),
      'renameTable',
    );
    push(
      new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s`,
        'gi',
      ),
      'addColumn',
    );
    push(
      new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+ADD\s+CONSTRAINT\s+(${IDENT})\s+(PRIMARY\s+KEY|UNIQUE)\s*\(`,
        'gi',
      ),
      'addConstraint',
    );
    push(
      new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${IDENT})`,
        'gi',
      ),
      'dropConstraint',
    );
    // ADD CONSTRAINT ... PRIMARY KEY | UNIQUE USING INDEX: the constraint adopts
    // a prebuilt index (renaming it to the constraint's name) instead of
    // building one — how a key is swapped without a build under lock.
    push(
      new RegExp(
        String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+ADD\s+CONSTRAINT\s+(${IDENT})\s+(PRIMARY\s+KEY|UNIQUE)\s+USING\s+INDEX\s+(${IDENT})`,
        'gi',
      ),
      'adoptIndex',
    );
    push(
      new RegExp(
        String.raw`CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+(?:ONLY\s+)?${QUALIFIED}\s*(?:USING\s+\w+\s*)?\(`,
        'gi',
      ),
      'createIndex',
    );
    push(
      new RegExp(
        String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?((?:${IDENT}\s*,\s*)*${QUALIFIED})`,
        'gi',
      ),
      'dropIndex',
    );
    push(
      new RegExp(
        String.raw`ALTER\s+INDEX\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}\s+RENAME\s+TO\s+(${IDENT})`,
        'gi',
      ),
      'renameIndex',
    );
    events.sort((a, b) => a.at - b.at);

    for (const { kind, match } of events) {
      const openAt = match.index + match[0].length - 1;
      if (kind === 'createTable') {
        const table = unquote(match[1]);
        const { inner } = balanced(sql, openAt);
        const columns = new Set();
        for (const element of splitTopLevel(inner)) {
          const constraint = new RegExp(
            String.raw`^(?:CONSTRAINT\s+(${IDENT})\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(`,
            'i',
          ).exec(element);
          if (constraint) {
            const primary = /^PRIMARY/i.test(constraint[2]);
            const name = constraint[1] ? unquote(constraint[1]) : primary ? `${table}_pkey` : null;
            const { inner: cols } = balanced(element, constraint[0].length - 1);
            if (name) {
              indexes.set(name, {
                table,
                columns: keyColumns(cols),
                unique: true,
                kind: primary ? 'primary key' : 'unique',
              });
            }
            continue;
          }
          if (/^(CONSTRAINT|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i.test(element)) continue;
          const column = new RegExp(`^(${IDENT})`).exec(element);
          if (!column) continue;
          const name = unquote(column[1]);
          columns.add(name);
          if (/\bPRIMARY\s+KEY\b/i.test(element)) {
            indexes.set(`${table}_pkey`, {
              table,
              columns: [name],
              unique: true,
              kind: 'primary key',
            });
          }
        }
        tables.set(table, columns);
      } else if (kind === 'dropTable') {
        const table = unquote(match[1]);
        tables.delete(table);
        for (const [name, index] of indexes) if (index.table === table) indexes.delete(name);
      } else if (kind === 'renameTable') {
        const from = unquote(match[1]);
        const to = unquote(match[2]);
        if (tables.has(from)) {
          tables.set(to, tables.get(from));
          tables.delete(from);
        }
        for (const index of indexes.values()) if (index.table === from) index.table = to;
      } else if (kind === 'addColumn') {
        const table = unquote(match[1]);
        const column = unquote(match[2]);
        if (['constraint', 'primary', 'unique', 'check', 'foreign'].includes(column)) continue;
        tables.get(table)?.add(column);
      } else if (kind === 'addConstraint') {
        const table = unquote(match[1]);
        const name = unquote(match[2]);
        const { inner } = balanced(sql, openAt);
        const primary = /^PRIMARY/i.test(match[3]);
        indexes.set(name, {
          table,
          columns: keyColumns(inner),
          unique: true,
          kind: primary ? 'primary key' : 'unique',
        });
      } else if (kind === 'adoptIndex') {
        const name = unquote(match[2]);
        const adopted = unquote(match[4]);
        const index = indexes.get(adopted);
        if (index) {
          indexes.delete(adopted);
          indexes.set(name, {
            ...index,
            unique: true,
            kind: /^PRIMARY/i.test(match[3]) ? 'primary key' : 'unique',
          });
        }
      } else if (kind === 'dropConstraint') {
        indexes.delete(unquote(match[2]));
      } else if (kind === 'createIndex') {
        const name = unquote(match[2]);
        const table = unquote(match[3]);
        const { inner } = balanced(sql, openAt);
        indexes.set(name, {
          table,
          columns: keyColumns(inner),
          unique: Boolean(match[1]),
          kind: match[1] ? 'unique index' : 'index',
        });
      } else if (kind === 'dropIndex') {
        for (const part of splitTopLevel(match[1])) {
          const name = new RegExp(`${QUALIFIED}$`).exec(part);
          if (name) indexes.delete(unquote(name[1]));
        }
      } else if (kind === 'renameIndex') {
        const from = unquote(match[1]);
        const to = unquote(match[2]);
        const index = indexes.get(from);
        if (index) {
          indexes.delete(from);
          indexes.set(to, index);
        }
      }
    }
  }

  return { tables, indexes };
}

/**
 * @param {{ tables: Map<string, Set<string>>, indexes: Map<string, object> }} state
 * @param {Record<string, string>} exemptions  index name → reason
 * @returns {{ errors: string[], checked: number }}
 */
export function checkTenantIndexOrder(state, exemptions = {}, exemptTables = EXEMPT_TABLES) {
  const errors = [];
  let checked = 0;
  const used = new Set();

  for (const [name, index] of [...state.indexes].sort(([a], [b]) => a.localeCompare(b))) {
    const columns = state.tables.get(index.table);
    if (!columns || !columns.has(TENANT_COLUMN)) continue;
    if (index.table in exemptTables) continue;
    if (index.columns.length < 2) continue;
    checked += 1;

    const leads = index.columns[0] === TENANT_COLUMN;
    if (name in exemptions) {
      used.add(name);
      if (leads) errors.push(`${name}: already leads with ${TENANT_COLUMN}; remove its exemption`);
      continue;
    }
    if (!leads) {
      errors.push(
        `${name}: ${index.kind} on tenant table "${index.table}" (${index.columns.join(', ')}) ` +
          `must lead with ${TENANT_COLUMN}, or be exempted with its reason`,
      );
    }
  }

  for (const name of Object.keys(exemptions)) {
    if (used.has(name)) continue;
    const index = state.indexes.get(name);
    if (!index) errors.push(`${name}: exempted, but no such index exists; remove the exemption`);
    else if (index.columns.length < 2)
      errors.push(`${name}: exempted, but it is not composite; remove the exemption`);
    else
      errors.push(
        `${name}: exempted, but "${index.table}" is not a tenant table; remove the exemption`,
      );
  }

  return { errors, checked };
}
