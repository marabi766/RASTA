import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as contracts from '../index';
import { TOPIC_CONSUMERS, consumerDeclarationProblem } from './topic-consumers';

/**
 * Every `EventConsumer` in the repository is declared in `TOPIC_CONSUMERS`,
 * and every declaration has a consumer (RUN-006).
 *
 * `EventConsumer` checks its own configuration when it is built, but only a
 * booted service builds one, and CI boots few of them. This reads the source
 * instead: each `new EventConsumer({...})` under `services/<service>/src`,
 * its `groupId`, `topics` and `deadLetterTopic` resolved from the literals
 * and constants it names, and held against the declaration. A new consumer,
 * a new subscription or a new service that forgets the contract fails here,
 * in the unit stage, not at the broker.
 *
 * The resolver understands the forms the services use — string literals,
 * `const` names (in any file of the same service), `[...NAME]`, array
 * literals, `NAME.property` of an object literal, `` `${NAME}.dlq` `` and
 * `env.X ?? NAME`, and string constants exported by this package. A value it
 * cannot resolve fails the test, unless it is
 * one of the listed derivations below, so a new form is noticed rather than
 * skipped.
 *
 * packages/contracts/turbo.json adds `services/*\/src` to this package's test
 * inputs, so a cached green is not replayed after a service changes.
 */

const REPO = resolve(__dirname, '../../../..');
const SERVICES = join(REPO, 'services');

/**
 * Topic lists computed at run time rather than written down, and why each is
 * still checked: audit-service's projector reads every declared topic except
 * the trail (`AUDIT_DOMAIN_TOPIC_OWNERS`, derived from `TOPIC_PRODUCERS`), and
 * its declaration is every declared topic.
 */
const DERIVED_TOPICS: Readonly<Record<string, string>> = {
  'audit-service:[...DOMAIN_TOPICS]': 'every TOPIC_PRODUCERS topic but the trail',
};

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** The text of the first argument of each `new EventConsumer(` call. */
function consumerOptions(text: string): string[] {
  const found: string[] = [];
  let at = text.indexOf('new EventConsumer(');
  while (at >= 0) {
    const open = text.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    found.push(text.slice(open + 1, end));
    at = text.indexOf('new EventConsumer(', end);
  }
  return found;
}

/** The expression after `key:` up to the end of its line, without the trailing comma. */
function field(options: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}:\\s*(.+?),?\\s*$`, 'm').exec(options);
  return match?.[1]?.trim();
}

class Resolver {
  constructor(private readonly sources: string) {}

  private definition(name: string): string | undefined {
    const match = new RegExp(
      `(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*([\\s\\S]*?);\\s*\\n`,
    ).exec(this.sources);
    return match?.[1]
      ?.trim()
      .replace(/\s+as\s+const$/, '')
      .replace(/^Object\.freeze\(([\s\S]*)\)$/, '$1')
      .trim();
  }

  string(expression: string): string | undefined {
    const expr = expression.trim();
    const literal = /^(['"])([^'"]*)\1$/.exec(expr);
    if (literal) return literal[2];
    const template = /^`\$\{(\w+)\}([^`]*)`$/.exec(expr);
    if (template) {
      const head = this.string(template[1]!);
      return head === undefined ? undefined : head + template[2];
    }
    const fallback = /\?\?\s*(\w+)$/.exec(expr);
    if (fallback) return this.string(fallback[1]!);
    const member = /^(\w+)\.(\w+)$/.exec(expr);
    if (member) {
      const object = this.definition(member[1]!);
      const property = object && new RegExp(`\\b${member[2]}:\\s*(['"])([^'"]+)\\1`).exec(object);
      return property ? property[2] : undefined;
    }
    if (/^\w+$/.test(expr)) {
      const value = this.definition(expr);
      if (value !== undefined) return this.string(value);
      // A constant the service imports from this package.
      const exported: unknown = (contracts as Record<string, unknown>)[expr];
      return typeof exported === 'string' ? exported : undefined;
    }
    return undefined;
  }

  strings(expression: string): string[] | undefined {
    const expr = expression.trim();
    const spread = /^\[\s*\.\.\.(\w+)\s*\]$/.exec(expr);
    if (spread) return this.strings(spread[1]!);
    if (expr.startsWith('[') && expr.endsWith(']')) {
      const items = expr
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      const values = items.map((item) => this.string(item));
      return values.every((value): value is string => value !== undefined) ? values : undefined;
    }
    if (/^\w+$/.test(expr)) {
      const value = this.definition(expr);
      return value === undefined ? undefined : this.strings(value);
    }
    return undefined;
  }
}

interface FoundConsumer {
  service: string;
  file: string;
  groupId: string | undefined;
  topicsExpression: string;
  topics: string[] | undefined;
  deadLetterTopic: string | undefined;
}

function scan(): FoundConsumer[] {
  const found: FoundConsumer[] = [];
  for (const service of readdirSync(SERVICES)) {
    const src = join(SERVICES, service, 'src');
    let files: string[];
    try {
      files = sourceFiles(src);
    } catch {
      continue;
    }
    const sources = files.map((file) => readFileSync(file, 'utf8'));
    const resolver = new Resolver(sources.join('\n'));
    files.forEach((file, index) => {
      for (const options of consumerOptions(sources[index]!)) {
        const topicsExpression = field(options, 'topics') ?? '';
        const dlq = field(options, 'deadLetterTopic');
        found.push({
          service,
          file: relative(REPO, file),
          groupId: resolver.string(field(options, 'groupId') ?? ''),
          topicsExpression,
          topics: resolver.strings(topicsExpression),
          deadLetterTopic: dlq === undefined ? undefined : resolver.string(dlq),
        });
      }
    });
  }
  return found;
}

describe('every EventConsumer in the repository is declared in TOPIC_CONSUMERS', () => {
  const consumers = scan();

  it('finds the consumers it is meant to check', () => {
    // A scanner that found nothing would pass everything.
    expect(consumers.length).toBeGreaterThanOrEqual(Object.keys(TOPIC_CONSUMERS).length);
  });

  it('declares exactly the services that run a consumer', () => {
    const running = [...new Set(consumers.map((consumer) => consumer.service))].sort();
    expect(running).toEqual(Object.keys(TOPIC_CONSUMERS).sort());
  });

  it('resolves every group, topic list and dead-letter topic it reads', () => {
    const unresolved = consumers
      .filter(
        (consumer) =>
          consumer.groupId === undefined ||
          consumer.deadLetterTopic === undefined ||
          (consumer.topics === undefined &&
            DERIVED_TOPICS[`${consumer.service}:${consumer.topicsExpression}`] === undefined),
      )
      .map((consumer) => `${consumer.file}: ${JSON.stringify(consumer)}`);
    expect(unresolved).toEqual([]);
  });

  it('holds each one to its service’s declaration', () => {
    const problems = consumers
      .map((consumer) => {
        const problem = consumerDeclarationProblem(consumer.service, {
          groupId: consumer.groupId ?? '',
          topics: consumer.topics ?? [],
          ...(consumer.deadLetterTopic ? { deadLetterTopic: consumer.deadLetterTopic } : {}),
        });
        return problem && `${consumer.file}: ${problem}`;
      })
      .filter((problem) => problem !== undefined);
    expect(problems).toEqual([]);
  });

  it('would catch an undeclared subscription, group or dead-letter topic', () => {
    // The check above is only as good as its refusals; these are its three.
    expect(
      consumerDeclarationProblem('fleet-service', {
        groupId: 'fleet-service.asset-sync',
        topics: ['rasta.economic.v1'],
      }),
    ).toBeDefined();
    expect(
      consumerDeclarationProblem('fleet-service', {
        groupId: 'economic-service.x',
        topics: [],
      }),
    ).toBeDefined();
    expect(
      consumerDeclarationProblem('fleet-service', {
        groupId: 'fleet-service.x',
        topics: [],
        deadLetterTopic: 'rasta.asset.v1.dlq',
      }),
    ).toBeDefined();
  });
});
