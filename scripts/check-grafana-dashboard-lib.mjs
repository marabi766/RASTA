/**
 * Contract checks for the provisioned local Grafana dashboard `Rasta Audit
 * Evidence` (docs/13-observability.md § 13.7).
 *
 * Grafana accepts almost any JSON as a dashboard and renders a broken query as
 * an empty panel, so nothing at runtime notices when a panel stops showing the
 * signal it claims to. These checks pin what the dashboard must keep showing:
 * the provisioned datasource UID on every query, every alert in the rules file,
 * the exact aggregations the alerts use, the boundary text, and no label that
 * could carry a tenant, actor, record or error identifier.
 *
 * Pure functions over already-read text, so the tests can feed mutated copies.
 * Node built-ins only. The CLI is `check-grafana-dashboard.mjs`; the live
 * Grafana/Prometheus check is `verify-grafana-dashboard-live.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PATHS = Object.freeze({
  dashboard: 'infrastructure/docker/grafana/dashboards/rasta-audit-evidence.json',
  dashboardsDir: 'infrastructure/docker/grafana/dashboards',
  datasource: 'infrastructure/docker/grafana/provisioning/datasources/prometheus.yml',
  provider: 'infrastructure/docker/grafana/provisioning/dashboards/rasta.yml',
  pluginsDir: 'infrastructure/docker/grafana/provisioning/plugins',
  plugins: 'infrastructure/docker/grafana/provisioning/plugins/rasta.yml',
  alertingDir: 'infrastructure/docker/grafana/provisioning/alerting',
  alerting: 'infrastructure/docker/grafana/provisioning/alerting/rasta.yml',
  rules: 'infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml',
  compose: 'docker-compose.yml',
});

export const EXPECTED = Object.freeze({
  uid: 'rasta-audit-evidence',
  title: 'Rasta Audit Evidence',
  tags: Object.freeze(['rasta', 'audit', 'local']),
  datasourceUid: 'rasta-prometheus',
  datasourceUrl: 'http://prometheus:9090',
  folder: 'Rasta',
  dashboardMount: './infrastructure/docker/grafana/dashboards:/etc/grafana/dashboards:ro',
  dashboardContainerPath: '/etc/grafana/dashboards',
  scrapeJobs: Object.freeze(['audit-service', 'identity-service', 'kafka-exporter']),
  consumerGroups: Object.freeze(['audit-service.domain-projector', 'audit-service.trail']),
  auditDlqTopic: 'rasta.audit.v1.dlq',
  /**
   * Environment of the Compose `grafana` service that keeps a local Grafana
   * 11.5.1 from calling out: usage reporting, core and plugin update checks, the
   * news feed, the first-boot download of preinstalled app plugins, and the
   * download of the plugin-signature public keys from grafana.com (which, with no
   * route out, logs `level=error` from `plugin.signature.key_retriever`). The
   * live verifier starts its container with the same values.
   */
  grafanaNoOutboundEnv: Object.freeze({
    GF_ANALYTICS_REPORTING_ENABLED: 'false',
    GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
    GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
    GF_NEWS_NEWS_FEED_ENABLED: 'false',
    GF_PLUGINS_PREINSTALL_DISABLED: 'true',
    GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED: 'true',
  }),
  /**
   * The only content lines, comments and blank lines aside, of the two inert
   * provisioning files. Grafana logs an error on every start for a provisioning
   * directory that does not exist, so each exists with a file that provisions
   * nothing: no app plugin, and no alert rule group, contact point, policy,
   * template or mute timing.
   */
  inertPluginsLines: Object.freeze(['apiVersion: 1', 'apps: []']),
  inertAlertingLines: Object.freeze(['apiVersion: 1']),
});

/**
 * Sentences that must stay visible on the dashboard, matched case-insensitively
 * with whitespace collapsed. They are the dashboard's honesty boundary: local
 * only, nothing is delivered to a person, and silence is not completeness.
 */
export const BOUNDARY_PHRASES = Object.freeze([
  'local development telemetry',
  'no alertmanager',
  'no notification delivery',
  'absence of alerts is not proof that every state change produced audit evidence',
]);

/**
 * Every label a query may group by, match on, or print in a legend. All are
 * closed sets declared by the metric contracts or Prometheus itself. Anything
 * else is refused, so a new label has to be reviewed here before it can reach
 * a panel.
 */
export const ALLOWED_LABELS = Object.freeze(
  new Set([
    'alertname',
    'alertstate',
    'severity',
    'job',
    'source_service',
    'source_topic',
    'outcome',
    'le',
    'consumergroup',
    'topic',
    'reason',
    'scope',
    'service',
  ]),
);

/**
 * Identifier-shaped tokens that name per-tenant, per-actor or per-record data.
 * Refused anywhere in a query or legend as a whole token (`partition` inside
 * `kafka_topic_partition_current_offset` is not a token), and in any free text
 * in their snake_case/camelCase forms.
 */
export const FORBIDDEN_QUERY_TOKENS = Object.freeze([
  'tenant',
  'tenant_id',
  'tenantId',
  'organization',
  'organization_id',
  'organizationId',
  'org_id',
  'actor',
  'actor_id',
  'actorId',
  'user_id',
  'userId',
  'resource',
  'resource_id',
  'resourceId',
  'event_id',
  'eventId',
  'correlation',
  'correlation_id',
  'correlationId',
  'causation_id',
  'request_id',
  'trace_id',
  'partition',
  'offset',
  'error',
  'error_message',
  'errorMessage',
  'message',
]);

export const FORBIDDEN_TEXT_TOKENS = Object.freeze(
  FORBIDDEN_QUERY_TOKENS.filter((token) => /_|[a-z][A-Z]/.test(token)),
);

/** Metrics whose meaning the dashboard must not misrepresent. */
export const FORBIDDEN_METRICS = Object.freeze({
  rasta_security_event_outbox_pending_age_seconds:
    'open-window pending age sits near the aggregation window by design; closed backlog age is the backlog signal',
  rasta_audit_partition_rows:
    'per-partition row counts are capacity data, not audit-evidence health',
});

/** Strips all whitespace so signal checks do not depend on query formatting. */
export const compact = (text) => String(text).replace(/\s+/g, '');

const normalizeProse = (text) => String(text).replace(/\s+/g, ' ').toLowerCase();

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasToken = (text, token) =>
  new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}($|[^A-Za-z0-9_])`).test(text);

/** Alert and recording rule names from the Prometheus rules file. */
export function parseRuleNames(rulesText) {
  const alerts = [...rulesText.matchAll(/^\s*-\s*alert:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  const records = [...rulesText.matchAll(/^\s*-\s*record:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  return { alerts, records };
}

/** Every query target with its panel, in panel order. */
export function collectTargets(dashboard) {
  const out = [];
  for (const panel of Array.isArray(dashboard?.panels) ? dashboard.panels : []) {
    for (const target of Array.isArray(panel.targets) ? panel.targets : []) {
      out.push({ panel, target });
    }
  }
  return out;
}

/** Label names a PromQL expression groups by, matches on, or selects with. */
export function labelsUsed(expr) {
  const labels = new Set();
  for (const m of expr.matchAll(
    /\b(?:by|without|on|ignoring|group_left|group_right)\s*\(([^)]*)\)/g,
  )) {
    for (const name of m[1].split(',')) if (name.trim()) labels.add(name.trim());
  }
  for (const m of expr.matchAll(/\{([^}]*)\}/g)) {
    for (const matcher of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)/g)) {
      labels.add(matcher[1]);
    }
  }
  return labels;
}

/** Label names a legend template prints. */
export function legendLabels(legendFormat) {
  return new Set(
    [...String(legendFormat ?? '').matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((m) => m[1]),
  );
}

const panelName = (panel) => `panel ${panel?.id ?? '?'} "${panel?.title ?? ''}"`;

function checkIdentity(dashboard, errors) {
  if (dashboard.uid !== EXPECTED.uid) {
    errors.push(`dashboard uid must be "${EXPECTED.uid}", found ${JSON.stringify(dashboard.uid)}`);
  }
  if (dashboard.title !== EXPECTED.title) {
    errors.push(
      `dashboard title must be "${EXPECTED.title}", found ${JSON.stringify(dashboard.title)}`,
    );
  }
  const tags = Array.isArray(dashboard.tags) ? dashboard.tags : [];
  for (const tag of EXPECTED.tags) {
    if (!tags.includes(tag)) errors.push(`dashboard tags must include "${tag}"`);
  }
  if (!dashboard.time?.from || !dashboard.time?.to) {
    errors.push('dashboard must set an explicit default time range');
  }
  if (typeof dashboard.refresh !== 'string' || dashboard.refresh === '') {
    errors.push('dashboard must set an explicit refresh interval');
  }
}

function checkLayout(panels, errors) {
  const seen = new Map();
  const boxes = [];
  for (const panel of panels) {
    if (!Number.isInteger(panel.id) || panel.id <= 0) {
      errors.push(`${panelName(panel)}: panel id must be a positive integer`);
    } else if (seen.has(panel.id)) {
      errors.push(
        `${panelName(panel)}: duplicate panel id ${panel.id} (also ${seen.get(panel.id)})`,
      );
    } else {
      seen.set(panel.id, panelName(panel));
    }
    if (panel.type === 'row' || Array.isArray(panel.panels)) {
      errors.push(`${panelName(panel)}: row panels are not supported by this contract`);
    }
    if (typeof panel.title !== 'string' || panel.title.trim() === '') {
      errors.push(`${panelName(panel)}: panel must have a title`);
    }
    if (typeof panel.description !== 'string' || panel.description.trim() === '') {
      errors.push(`${panelName(panel)}: panel must have a description`);
    }
    const g = panel.gridPos;
    const valid =
      g &&
      [g.x, g.y, g.w, g.h].every(Number.isInteger) &&
      g.x >= 0 &&
      g.y >= 0 &&
      g.w > 0 &&
      g.h > 0 &&
      g.x + g.w <= 24;
    if (!valid) {
      errors.push(`${panelName(panel)}: gridPos must be integers inside the 24-column grid`);
      continue;
    }
    for (const other of boxes) {
      const o = other.panel.gridPos;
      if (g.x < o.x + o.w && o.x < g.x + g.w && g.y < o.y + o.h && o.y < g.y + g.h) {
        errors.push(`${panelName(panel)}: gridPos overlaps ${panelName(other.panel)}`);
      }
    }
    boxes.push({ panel });
  }
}

function checkDatasources(dashboard, errors) {
  if (dashboard.__inputs !== undefined || dashboard.__requires !== undefined) {
    errors.push(
      'dashboard must not declare __inputs/__requires (export-for-sharing datasource inputs)',
    );
  }
  for (const variable of dashboard.templating?.list ?? []) {
    if (variable?.type === 'datasource') {
      errors.push(
        `templating variable "${variable.name}" is a datasource variable; use the provisioned UID`,
      );
    }
  }
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        const here = `${path}.${key}`;
        if (key === 'datasource') {
          if (
            !value ||
            typeof value !== 'object' ||
            value.uid !== EXPECTED.datasourceUid ||
            value.type !== 'prometheus'
          ) {
            errors.push(
              `${here}: datasource must be {"type":"prometheus","uid":"${EXPECTED.datasourceUid}"}, found ${JSON.stringify(value)}`,
            );
          }
        }
        walk(value, here);
      }
      return;
    }
    if (typeof node === 'string') {
      if (/https?:\/\//i.test(node)) errors.push(`${path}: external URL is not allowed`);
      if (/\$\{?DS_/.test(node)) errors.push(`${path}: datasource input variable is not allowed`);
    }
  };
  walk(dashboard, 'dashboard');
}

function checkTargets(panels, errors) {
  for (const panel of panels) {
    const targets = Array.isArray(panel.targets) ? panel.targets : [];
    if (panel.type === 'text') {
      if (targets.length > 0) errors.push(`${panelName(panel)}: text panel must not have queries`);
      continue;
    }
    if (targets.length === 0) {
      errors.push(`${panelName(panel)}: panel has no query`);
      continue;
    }
    if (
      panel.datasource?.uid !== EXPECTED.datasourceUid ||
      panel.datasource?.type !== 'prometheus'
    ) {
      errors.push(`${panelName(panel)}: panel datasource must use uid "${EXPECTED.datasourceUid}"`);
    }
    const refIds = new Set();
    for (const target of targets) {
      const label = `${panelName(panel)} target ${target.refId ?? '?'}`;
      if (typeof target.refId !== 'string' || target.refId === '' || refIds.has(target.refId)) {
        errors.push(`${label}: refId must be present and unique within the panel`);
      }
      refIds.add(target.refId);
      if (target.hide === true) errors.push(`${label}: hidden targets are not allowed`);
      if (typeof target.expr !== 'string' || target.expr.trim() === '') {
        errors.push(`${label}: query expression is empty`);
        continue;
      }
      if (target.datasource?.uid !== EXPECTED.datasourceUid) {
        errors.push(`${label}: target datasource must use uid "${EXPECTED.datasourceUid}"`);
      }
      for (const name of labelsUsed(target.expr)) {
        if (!ALLOWED_LABELS.has(name)) {
          errors.push(`${label}: label "${name}" is not in the bounded label allowlist`);
        }
      }
      for (const name of legendLabels(target.legendFormat)) {
        if (!ALLOWED_LABELS.has(name)) {
          errors.push(`${label}: legend label "${name}" is not in the bounded label allowlist`);
        }
      }
      for (const token of FORBIDDEN_QUERY_TOKENS) {
        if (hasToken(target.expr, token) || hasToken(target.legendFormat ?? '', token)) {
          errors.push(`${label}: forbidden identifier "${token}" in query or legend`);
        }
      }
      for (const [metric, why] of Object.entries(FORBIDDEN_METRICS)) {
        if (hasToken(target.expr, metric))
          errors.push(`${label}: must not query ${metric} — ${why}`);
      }
    }
  }
}

function checkText(dashboard, panels, errors) {
  const prose = [
    ['dashboard.title', dashboard.title],
    ['dashboard.description', dashboard.description],
    ...panels.flatMap((p) => [
      [`${panelName(p)} title`, p.title],
      [`${panelName(p)} description`, p.description],
      [`${panelName(p)} content`, p.options?.content],
    ]),
  ];
  for (const [where, text] of prose) {
    if (typeof text !== 'string') continue;
    for (const token of FORBIDDEN_TEXT_TOKENS) {
      if (hasToken(text, token)) errors.push(`${where}: forbidden identifier "${token}"`);
    }
  }
  const textPanels = panels.filter((p) => p.type === 'text');
  if (textPanels.length === 0) {
    errors.push('dashboard must have a text panel stating its boundary');
  }
  const visible = normalizeProse(textPanels.map((p) => p.options?.content ?? '').join('\n'));
  const description = normalizeProse(dashboard.description ?? '');
  for (const phrase of BOUNDARY_PHRASES) {
    if (!visible.includes(phrase)) errors.push(`boundary text panel is missing "${phrase}"`);
    if (!description.includes(phrase)) errors.push(`dashboard description is missing "${phrase}"`);
  }
}

/**
 * The operational questions the dashboard must answer, each as a predicate over
 * the compacted query expressions. Exact aggregation shapes are pinned where an
 * alert defines them, so a panel cannot drift from the alert it explains.
 */
export function requiredSignals({ alerts, records }) {
  const any = (fragments) => (exprs) =>
    exprs.some((e) => fragments.every((fragment) => e.includes(compact(fragment))));
  const signals = [
    {
      id: 'alerts-pending-or-firing',
      what: 'a bounded ALERTS query by alertname, alertstate and severity',
      test: any(['ALERTS{alertname=~', 'by (alertname, alertstate, severity)']),
    },
    ...alerts.map((name) => ({
      id: `alert:${name}`,
      what: `alert ${name} in the ALERTS query`,
      test: (exprs) =>
        exprs.some(
          (e) =>
            e.includes('by(alertname,alertstate,severity)') &&
            new RegExp(`alertname=~"(?:[^"]*\\|)?${escapeRegExp(name)}(?:\\|[^"]*)?"`).test(e),
        ),
    })),
    ...EXPECTED.scrapeJobs.map((job) => ({
      id: `scrape-job:${job}`,
      what: `up for scrape job ${job}, including a missing job`,
      test: (exprs) =>
        exprs.some(
          (e) =>
            e.includes('minby(job)(up{job=~') &&
            new RegExp(`up\\{job=~"(?:[^"]*\\|)?${escapeRegExp(job)}(?:\\|[^"]*)?"\\}`).test(e) &&
            e.includes(`absent(up{job="${job}"})`),
        ),
    })),
    {
      id: 'ingestion-throughput',
      what: 'rasta_audit_records_ingested_total by source_service and outcome',
      test: any(['sum by (source_service, outcome) (rate(rasta_audit_records_ingested_total[']),
    },
    {
      id: 'ingestion-lag-p95',
      what: 'the RastaAuditIngestionLagHigh p95 aggregation',
      test: any([
        'histogram_quantile(0.95, sum by (le, source_topic) (rate(rasta_audit_ingestion_lag_seconds_bucket[5m])))',
      ]),
    },
    ...EXPECTED.consumerGroups.map((group) => ({
      id: `consumer-lag:${group}`,
      what: `clamped kafka_consumergroup_lag for ${group} by consumergroup and topic`,
      test: any([
        `sum by (consumergroup, topic) (clamp_min(kafka_consumergroup_lag{consumergroup="${group}"}, 0))`,
      ]),
    })),
    ...records.map((record) => ({
      id: `recording-rule:${record}`,
      what: `recording rule ${record} for ${EXPECTED.auditDlqTopic}`,
      test: any([`${record}{topic="${EXPECTED.auditDlqTopic}"}`]),
    })),
    {
      id: 'audit-dlq-writes',
      what: 'rasta_dlq_messages_total from the audit-service job by service, topic and reason',
      test: any([
        'sum by (service, topic, reason) (increase(rasta_dlq_messages_total{job="audit-service"}[5m]))',
      ]),
    },
    {
      id: 'ingestion-failures',
      what: 'rasta_audit_ingestion_failures_total by reason',
      test: any(['sum by (reason) (increase(rasta_audit_ingestion_failures_total[5m]))']),
    },
    {
      id: 'chain-verification-failures',
      what: 'rasta_audit_chain_verification_failures_total by reason and scope',
      test: any([
        'sum by (reason, scope) (increase(rasta_audit_chain_verification_failures_total[5m]))',
      ]),
    },
    {
      id: 'refusal-capture-gaps',
      what: 'rasta_security_event_captures_total with outcome failed|timeout',
      test: any([
        'sum by (outcome) (increase(rasta_security_event_captures_total{outcome=~"failed|timeout"}[5m]))',
      ]),
    },
    {
      id: 'refusal-publish-failures',
      what: 'rasta_security_event_publish_failures_total by reason',
      test: any(['sum by (reason) (increase(rasta_security_event_publish_failures_total[5m]))']),
    },
    {
      id: 'closed-backlog-age',
      what: 'rasta_security_event_outbox_closed_backlog_age_seconds',
      test: any(['rasta_security_event_outbox_closed_backlog_age_seconds']),
    },
    {
      id: 'expected-producer-silence',
      what: 'RastaAuditProducerSilent alert state for configured expected producers only',
      test: any([
        'ALERTS{alertname="RastaAuditProducerSilent"',
        'max by (source_service) (rasta_audit_expected_active_producer == 1)',
      ]),
    },
  ];
  return signals;
}

/** Checks a parsed dashboard model against the contract and the rules file. */
export function checkDashboard(dashboard, rules) {
  const errors = [];
  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
    return ['dashboard JSON must be an object'];
  }
  if (!rules?.alerts?.length || !rules?.records?.length) {
    errors.push('rules file yielded no alert or recording rule names — refusing to check coverage');
  }
  const panels = Array.isArray(dashboard.panels) ? dashboard.panels : [];
  if (panels.length === 0) errors.push('dashboard has no panels');
  checkIdentity(dashboard, errors);
  checkLayout(panels, errors);
  checkDatasources(dashboard, errors);
  checkTargets(panels, errors);
  checkText(dashboard, panels, errors);
  const exprs = collectTargets(dashboard)
    .filter(({ target }) => typeof target.expr === 'string' && target.hide !== true)
    .map(({ target }) => compact(target.expr));
  for (const signal of requiredSignals(rules ?? { alerts: [], records: [] })) {
    if (!signal.test(exprs)) errors.push(`missing required signal ${signal.id}: ${signal.what}`);
  }
  return errors;
}

/** Checks the provisioning files and the Compose mount that load the dashboard. */
export function checkProvisioning({ datasourceYaml, providerYaml, composeYaml }) {
  const errors = [];
  const needs = (text, pattern, message) => {
    if (!pattern.test(text)) errors.push(message);
  };
  needs(
    datasourceYaml,
    new RegExp(`^\\s*uid:\\s*${escapeRegExp(EXPECTED.datasourceUid)}\\s*$`, 'm'),
    `datasource provisioning must set uid: ${EXPECTED.datasourceUid}`,
  );
  needs(
    datasourceYaml,
    /^\s*type:\s*prometheus\s*$/m,
    'datasource provisioning must be type prometheus',
  );
  needs(
    datasourceYaml,
    new RegExp(`^\\s*url:\\s*${escapeRegExp(EXPECTED.datasourceUrl)}\\s*$`, 'm'),
    `datasource provisioning must point at ${EXPECTED.datasourceUrl}`,
  );
  needs(providerYaml, /^\s*type:\s*file\s*$/m, 'dashboard provider must be type file');
  needs(
    providerYaml,
    new RegExp(`^\\s*folder:\\s*${EXPECTED.folder}\\s*$`, 'm'),
    `dashboard provider must use folder ${EXPECTED.folder}`,
  );
  needs(
    providerYaml,
    /^\s*disableDeletion:\s*true\s*$/m,
    'dashboard provider must set disableDeletion: true',
  );
  needs(
    providerYaml,
    /^\s*allowUiUpdates:\s*false\s*$/m,
    'dashboard provider must set allowUiUpdates: false',
  );
  needs(
    providerYaml,
    new RegExp(`^\\s*path:\\s*${escapeRegExp(EXPECTED.dashboardContainerPath)}\\s*$`, 'm'),
    `dashboard provider path must be ${EXPECTED.dashboardContainerPath}`,
  );
  if (/https?:\/\//i.test(providerYaml)) errors.push('dashboard provider must not reference a URL');
  if (!composeYaml.includes(EXPECTED.dashboardMount)) {
    errors.push(`docker-compose.yml must mount ${EXPECTED.dashboardMount}`);
  }
  return errors;
}

/** Content lines of a small YAML file: comments and blank lines removed, trailing space trimmed. */
const contentLines = (text) =>
  String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+$/, ''));

/** Top-level key of a YAML line, if it has one. */
const topLevelKey = (line) => /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line)?.[1];

function checkInertFile(label, text, expectedLines, errors) {
  const lines = contentLines(text);
  if (lines.length === 0) {
    errors.push(`${label}: missing or empty — expected exactly ${expectedLines.join(' / ')}`);
    return;
  }
  for (const line of lines) {
    if (expectedLines.includes(line)) continue;
    const key = topLevelKey(line);
    errors.push(
      key && !expectedLines.some((expected) => topLevelKey(expected) === key)
        ? `${label}: declares "${key}" — this file must provision nothing`
        : `${label}: unexpected content "${line.trim()}" — this file must provision nothing`,
    );
  }
  for (const expected of expectedLines) {
    const count = lines.filter((line) => line === expected).length;
    if (count !== 1) {
      errors.push(`${label}: must contain "${expected}" exactly once, found ${count}`);
    }
  }
}

/**
 * The `environment` entries of the Compose `grafana` service, as written with
 * their quotes, each name mapped to every value it is given. `null` when there
 * is no `grafana` service. Reads only the two-space service / four-space key /
 * six-space entry layout this repository's Compose file uses.
 */
export function grafanaServiceEnvironment(composeYaml) {
  const lines = String(composeYaml).split(/\r?\n/);
  const start = lines.findIndex((line) => /^ {2}grafana:\s*$/.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && /^ {0,2}[^\s#]/.test(line));
  const block = lines.slice(start + 1, end < 0 ? lines.length : end);
  const envStart = block.findIndex((line) => /^ {4}environment:\s*$/.test(line));
  const env = new Map();
  if (envStart < 0) return env;
  for (const line of block.slice(envStart + 1)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    if (!/^ {6}\S/.test(line)) break;
    const match = /^ {6}([A-Za-z0-9_]+):\s*(.*?)\s*$/.exec(line);
    if (match) env.set(match[1], [...(env.get(match[1]) ?? []), match[2]]);
  }
  return env;
}

/**
 * Checks that local Compose Grafana starts self-contained and clean: the
 * no-outbound environment on the `grafana` service, and the two inert
 * provisioning files that stop Grafana logging a missing-directory error.
 */
export function checkGrafanaStartup({ composeYaml, pluginsYaml, alertingYaml }) {
  const errors = [];
  const env = grafanaServiceEnvironment(composeYaml);
  if (env === null) {
    errors.push('docker-compose.yml: no grafana service found');
  } else {
    for (const [name, value] of Object.entries(EXPECTED.grafanaNoOutboundEnv)) {
      const written = env.get(name) ?? [];
      if (written.length === 0) {
        errors.push(`docker-compose.yml grafana environment must set ${name}: '${value}'`);
      } else if (written.length > 1) {
        errors.push(`docker-compose.yml grafana environment sets ${name} more than once`);
      } else if (written[0] !== `'${value}'` && written[0] !== `"${value}"`) {
        errors.push(
          `docker-compose.yml grafana environment must set ${name}: '${value}' (quoted), found ${written[0] || '(empty)'}`,
        );
      }
    }
  }
  checkInertFile(PATHS.plugins, pluginsYaml, EXPECTED.inertPluginsLines, errors);
  checkInertFile(PATHS.alerting, alertingYaml, EXPECTED.inertAlertingLines, errors);
  return errors;
}

/** Reads the repository files and runs every check. */
export function checkRepository(root) {
  const errors = [];
  const read = (path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      errors.push(`${path}: file not found`);
      return '';
    }
    return readFileSync(absolute, 'utf8');
  };
  const rules = parseRuleNames(read(PATHS.rules));
  const dashboardText = read(PATHS.dashboard);
  let dashboard = null;
  if (dashboardText) {
    try {
      dashboard = JSON.parse(dashboardText);
    } catch (error) {
      errors.push(`${PATHS.dashboard}: invalid JSON — ${error.message}`);
    }
  }
  if (dashboard) errors.push(...checkDashboard(dashboard, rules));
  errors.push(
    ...checkProvisioning({
      datasourceYaml: read(PATHS.datasource),
      providerYaml: read(PATHS.provider),
      composeYaml: read(PATHS.compose),
    }),
  );
  errors.push(
    ...checkGrafanaStartup({
      composeYaml: read(PATHS.compose),
      pluginsYaml: read(PATHS.plugins),
      alertingYaml: read(PATHS.alerting),
    }),
  );
  for (const [dir, file] of [
    [PATHS.pluginsDir, PATHS.plugins],
    [PATHS.alertingDir, PATHS.alerting],
  ]) {
    // Grafana parses every YAML file in these directories; only the inert one may exist.
    if (!existsSync(join(root, dir))) continue;
    for (const name of readdirSync(join(root, dir))) {
      if (`${dir}/${name}` !== file) {
        errors.push(`${dir}/${name}: only ${file} belongs in this directory`);
      }
    }
  }
  const dashboardsDir = join(root, PATHS.dashboardsDir);
  if (existsSync(dashboardsDir)) {
    for (const name of readdirSync(dashboardsDir)) {
      if (!name.endsWith('.json')) {
        errors.push(
          `${PATHS.dashboardsDir}/${name}: only dashboard JSON belongs in this directory`,
        );
      }
    }
  }
  const panels = Array.isArray(dashboard?.panels) ? dashboard.panels : [];
  return {
    errors,
    summary: {
      panels: panels.length,
      targets: collectTargets(dashboard).length,
      alerts: rules.alerts.length,
      records: rules.records.length,
    },
  };
}
