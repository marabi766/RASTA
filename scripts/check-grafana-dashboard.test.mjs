import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED,
  PATHS,
  checkDashboard,
  checkProvisioning,
  checkRepository,
  collectTargets,
  labelsUsed,
  parseRuleNames,
} from './check-grafana-dashboard-lib.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const rules = parseRuleNames(read(PATHS.rules));
/** A fresh deep copy of the tracked dashboard for each mutation. */
const dashboard = () => JSON.parse(read(PATHS.dashboard));
const provisioning = () => ({
  datasourceYaml: read(PATHS.datasource),
  providerYaml: read(PATHS.provider),
  composeYaml: read(PATHS.compose),
});
const panel = (model, predicate) => model.panels.find(predicate);
const targetWith = (model, fragment) =>
  collectTargets(model).find(({ target }) => target.expr.includes(fragment));

/** Asserts the mutation produced at least one error matching `pattern`. */
function assertCaught(model, pattern) {
  const errors = checkDashboard(model, rules);
  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n') || '(none)'}`,
  );
}

test('the tracked dashboard, provisioning and Compose mount satisfy the contract', () => {
  const { errors, summary } = checkRepository(repoRoot);
  assert.deepEqual(errors, []);
  assert.equal(summary.alerts, 13);
  assert.equal(summary.records, 1);
  assert.ok(summary.panels >= 9 && summary.panels <= 12, `panels: ${summary.panels}`);
});

test('the rules file parser finds every alert and the recording rule', () => {
  assert.equal(rules.alerts.length, 13);
  assert.ok(rules.alerts.every((name) => name.startsWith('Rasta')));
  assert.deepEqual(rules.records, ['topic:kafka_topic_retained_records:sum']);
});

test('refuses a coverage check when the rules file yields nothing', () => {
  const errors = checkDashboard(dashboard(), { alerts: [], records: [] });
  assert.ok(errors.some((e) => /refusing to check coverage/.test(e)));
});

test('catches a wrong uid, title or missing tag', () => {
  const model = dashboard();
  model.uid = 'rasta-audit';
  model.title = 'Audit';
  model.tags = ['rasta', 'audit'];
  assertCaught(model, /uid must be "rasta-audit-evidence"/);
  assertCaught(model, /title must be "Rasta Audit Evidence"/);
  assertCaught(model, /tags must include "local"/);
});

test('catches a duplicate panel id', () => {
  const model = dashboard();
  model.panels[2].id = model.panels[1].id;
  assertCaught(model, /duplicate panel id/);
});

test('catches a non-positive panel id', () => {
  const model = dashboard();
  model.panels[3].id = 0;
  assertCaught(model, /positive integer/);
});

test('catches overlapping panels', () => {
  const model = dashboard();
  const moved = model.panels[4];
  moved.gridPos = { ...model.panels[3].gridPos, x: model.panels[3].gridPos.x + 1 };
  assertCaught(model, /gridPos overlaps/);
});

test('catches a panel outside the 24-column grid', () => {
  const model = dashboard();
  model.panels[5].gridPos.x = 20;
  assertCaught(model, /inside the 24-column grid/);
});

test('catches a wrong datasource UID on a target', () => {
  const model = dashboard();
  collectTargets(model)[0].target.datasource.uid = 'prometheus';
  assertCaught(model, /datasource must be \{"type":"prometheus","uid":"rasta-prometheus"\}/);
  assertCaught(model, /target datasource must use uid "rasta-prometheus"/);
});

test('catches a datasource referenced by name or through a variable', () => {
  const byName = dashboard();
  panel(byName, (p) => p.type === 'timeseries').datasource = 'Prometheus';
  assertCaught(byName, /datasource must be/);

  const variable = dashboard();
  variable.templating.list.push({ name: 'DS_PROMETHEUS', type: 'datasource', query: 'prometheus' });
  collectTargets(variable)[1].target.datasource = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };
  assertCaught(variable, /datasource variable/);
  assertCaught(variable, /datasource input variable is not allowed/);
});

test('catches an external datasource or URL', () => {
  const model = dashboard();
  panel(model, (p) => p.type === 'stat').datasource = { type: 'loki', uid: 'rasta-prometheus' };
  model.links.push({ title: 'x', url: 'https://grafana.example.com/d/abc' });
  assertCaught(model, /datasource must be/);
  assertCaught(model, /external URL is not allowed/);
});

test('catches a hidden target and an empty query', () => {
  const hidden = dashboard();
  collectTargets(hidden)[0].target.hide = true;
  assertCaught(hidden, /hidden targets are not allowed/);

  const empty = dashboard();
  targetWith(empty, 'rasta_security_event_publish_failures_total').target.expr = '  ';
  assertCaught(empty, /query expression is empty/);
  assertCaught(empty, /missing required signal refusal-publish-failures/);

  const noTargets = dashboard();
  panel(noTargets, (p) => p.type === 'table').targets = [];
  assertCaught(noTargets, /panel has no query/);
});

test('catches a missing alert in the ALERTS query', () => {
  const model = dashboard();
  const { target } = targetWith(model, 'by (alertname, alertstate, severity)');
  target.expr = target.expr.replace('RastaAuditChainDivergence|', '');
  assertCaught(model, /missing required signal alert:RastaAuditChainDivergence/);
});

test('catches an alert added to the rules file but not to the dashboard', () => {
  const errors = checkDashboard(dashboard(), {
    alerts: [...rules.alerts, 'RastaAuditSomethingNew'],
    records: rules.records,
  });
  assert.ok(errors.some((e) => /alert:RastaAuditSomethingNew/.test(e)));
});

test('catches each missing required signal family', () => {
  const cases = [
    [
      'up{job=~',
      'scrape-job:audit-service',
      (e) => e.replace('absent(up{job="audit-service"})', 'vector(0)'),
    ],
    [
      'rasta_audit_records_ingested_total',
      'ingestion-throughput',
      (e) => e.replace('source_service, outcome', 'source_topic'),
    ],
    [
      'rasta_audit_ingestion_lag_seconds_bucket',
      'ingestion-lag-p95',
      (e) => e.replace('0.95', '0.99'),
    ],
    [
      'audit-service.trail',
      'consumer-lag:audit-service.trail',
      (e) => e.replace('audit-service.trail', 'audit-service.other'),
    ],
    [
      'topic:kafka_topic_retained_records:sum',
      'recording-rule:topic:kafka_topic_retained_records:sum',
      (e) => e.replace('topic:kafka_topic_retained_records:sum', 'kafka_topic_partitions'),
    ],
    [
      'rasta_audit_chain_verification_failures_total',
      'chain-verification-failures',
      (e) => e.replace('reason, scope', 'reason'),
    ],
    [
      'rasta_security_event_captures_total',
      'refusal-capture-gaps',
      (e) => e.replace('failed|timeout', 'failed'),
    ],
    [
      'closed_backlog_age_seconds',
      'closed-backlog-age',
      () => 'max(rasta_security_events_published_total)',
    ],
    [
      'rasta_audit_expected_active_producer',
      'expected-producer-silence',
      (e) =>
        e.replace(
          /or \(max by \(source_service\) \(rasta_audit_expected_active_producer == 1\) \* 0\)/,
          '',
        ),
    ],
    ['rasta_dlq_messages_total', 'audit-dlq-writes', (e) => e.replace('{job="audit-service"}', '')],
  ];
  for (const [fragment, signal, mutate] of cases) {
    const model = dashboard();
    const found = targetWith(model, fragment);
    assert.ok(found, `fixture has a target containing ${fragment}`);
    found.target.expr = mutate(found.target.expr);
    assertCaught(
      model,
      new RegExp(`missing required signal ${signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  }
});

test('catches a forbidden identifier in a query, a legend or a description', () => {
  const query = dashboard();
  const found = targetWith(query, 'rasta_audit_ingestion_failures_total');
  found.target.expr =
    'sum by (reason, tenant_id) (increase(rasta_audit_ingestion_failures_total[5m]))';
  assertCaught(query, /label "tenant_id" is not in the bounded label allowlist/);
  assertCaught(query, /forbidden identifier "tenant_id" in query or legend/);

  const legend = dashboard();
  collectTargets(legend)[2].target.legendFormat = '{{actor_id}}';
  assertCaught(legend, /legend label "actor_id"/);

  const matcher = dashboard();
  targetWith(matcher, 'kafka_consumergroup_lag').target.expr =
    'sum by (consumergroup, topic) (kafka_consumergroup_lag{partition="0"})';
  assertCaught(matcher, /label "partition" is not in the bounded label allowlist/);

  const description = dashboard();
  panel(description, (p) => p.type === 'stat').description += ' Filter by correlationId.';
  assertCaught(description, /forbidden identifier "correlationId"/);
});

test('catches the open-window pending age used as backlog health', () => {
  const model = dashboard();
  targetWith(model, 'closed_backlog_age_seconds').target.expr =
    'max(rasta_security_event_outbox_pending_age_seconds)';
  assertCaught(model, /must not query rasta_security_event_outbox_pending_age_seconds/);
});

test('catches missing boundary text in the text panel or the description', () => {
  const visible = dashboard();
  const text = panel(visible, (p) => p.type === 'text');
  text.options.content = text.options.content.replace(/no Alertmanager/g, 'Alertmanager');
  assertCaught(visible, /boundary text panel is missing "no alertmanager"/);

  const described = dashboard();
  described.description = 'Audit metrics.';
  assertCaught(described, /dashboard description is missing "absence of alerts is not proof/);

  const noPanel = dashboard();
  noPanel.panels = noPanel.panels.filter((p) => p.type !== 'text');
  assertCaught(noPanel, /must have a text panel/);
});

test('labelsUsed reads grouping, join and matcher labels', () => {
  assert.deepEqual(
    [...labelsUsed('sum by (a, b) (x{c="1", d=~"2"}) and on (e) y unless ignoring(f) z')].sort(),
    ['a', 'b', 'c', 'd', 'e', 'f'],
  );
});

test('catches provisioning drift', () => {
  const base = provisioning();
  const cases = [
    [
      { datasourceYaml: base.datasourceYaml.replace(/uid: rasta-prometheus/, 'uid: other') },
      /uid: rasta-prometheus/,
    ],
    [
      {
        providerYaml: base.providerYaml.replace('disableDeletion: true', 'disableDeletion: false'),
      },
      /disableDeletion/,
    ],
    [
      { providerYaml: base.providerYaml.replace('folder: Rasta', 'folder: General') },
      /folder Rasta/,
    ],
    [
      {
        providerYaml: base.providerYaml.replaceAll(
          '/etc/grafana/dashboards',
          '/etc/grafana/provisioning/dashboards',
        ),
      },
      /provider path/,
    ],
    [
      {
        composeYaml: base.composeYaml.replace(
          EXPECTED.dashboardMount,
          EXPECTED.dashboardMount.replace(':ro', ''),
        ),
      },
      /must mount/,
    ],
  ];
  assert.deepEqual(checkProvisioning(base), []);
  for (const [override, pattern] of cases) {
    const errors = checkProvisioning({ ...base, ...override });
    assert.ok(
      errors.some((e) => pattern.test(e)),
      `expected ${pattern}, got ${errors.join('; ')}`,
    );
  }
});

test('the CLI exits nonzero and names the defect for invalid JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'rasta-grafana-dashboard-'));
  try {
    for (const path of [PATHS.rules, PATHS.datasource, PATHS.provider, PATHS.compose]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repoRoot, path), join(root, path));
    }
    mkdirSync(join(root, PATHS.dashboardsDir), { recursive: true });
    writeFileSync(join(root, PATHS.dashboard), '{ "uid": "rasta-audit-evidence", ');
    const cli = join(repoRoot, 'scripts', 'check-grafana-dashboard.mjs');
    const broken = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /invalid JSON/);

    cpSync(join(repoRoot, PATHS.dashboard), join(root, PATHS.dashboard));
    const ok = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stderr, /13 alerts and 1 recording rule/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
