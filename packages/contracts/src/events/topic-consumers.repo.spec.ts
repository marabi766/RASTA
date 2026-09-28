import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { TOPIC_CONSUMERS, consumerDeclarationProblem } from './topic-consumers';

/**
 * Every Kafka consumer in the repository's services is an `EventConsumer`
 * declared in `TOPIC_CONSUMERS`, and every declaration has a consumer
 * (RUN-006).
 *
 * `EventConsumer` checks its own configuration when it is built, but only a
 * booted service builds one, and CI boots few of them. This reads the source
 * instead, with the TypeScript compiler and its type checker, so what counts is
 * what a construction *is*, not how it is spelled (PM + Codex review of #128,
 * finding 2):
 *
 *   - every `new X(...)` whose instance type is nest-common's `EventConsumer`,
 *     however `X` is reached — an aliased import, a namespace import, a local
 *     re-binding — and every class that extends it;
 *   - every `.consumer` taken from a kafkajs `Kafka` client in production
 *     code: a consumer outside `EventConsumer` is outside every check, so it
 *     is refused outright;
 *   - each `EventConsumer`'s `groupId`, `topics` and `deadLetterTopic`,
 *     evaluated from literals, constants (followed across files and
 *     packages), templates, spreads and literal types. A topic list computed
 *     at run time is taken at its **type**: audit-service's derived domain
 *     topics are `readonly AuditDomainTopic[]`, every topic that list can ever
 *     hold, and that set is held against the declaration like any other.
 *
 * Anything it cannot evaluate — a factory whose options arrive as a
 * parameter, an environment value with no declared default — fails the test,
 * so a new form is noticed rather than skipped.
 *
 * packages/contracts/turbo.json adds `services/*\/src` to this package's test
 * inputs, so a cached green is not replayed after a service changes.
 */

const REPO = resolve(__dirname, '../../../..');
const SERVICES = join(REPO, 'services');

/** How the services compile, with `@rasta/*` read from source so no build is needed first. */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true,
  esModuleInterop: true,
  experimentalDecorators: true,
  skipLibCheck: true,
  noEmit: true,
  baseUrl: REPO,
  paths: { '@rasta/*': ['packages/*/src'] },
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

/** `services/<name>/src/**` production files, per service. */
function serviceSources(): Map<string, string[]> {
  const byService = new Map<string, string[]>();
  for (const service of readdirSync(SERVICES)) {
    const src = join(SERVICES, service, 'src');
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    byService.set(service, sourceFiles(src));
  }
  return byService;
}

interface FoundConsumer {
  service: string;
  file: string;
  groupId: string | undefined;
  topics: string[] | undefined;
  /** `undefined` = not set; `null` = set to something that could not be evaluated. */
  deadLetterTopic: string | undefined | null;
}

interface ScanResult {
  consumers: FoundConsumer[];
  /** Kafka consumers built any way other than a declared `EventConsumer`. */
  violations: string[];
}

/** Values a string-typed expression can take, or `undefined` when unknown. */
class Evaluator {
  constructor(private readonly checker: ts.TypeChecker) {}

  private literals(type: ts.Type): string[] | undefined {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion()) {
      const values: string[] = [];
      for (const member of type.types) {
        if (!member.isStringLiteral()) return undefined;
        values.push(member.value);
      }
      return values;
    }
    return undefined;
  }

  private unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    for (;;) {
      if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) {
        current = current.expression;
      } else if (ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
      } else if (
        ts.isCallExpression(current) &&
        current.expression.getText() === 'Object.freeze' &&
        current.arguments.length === 1
      ) {
        current = current.arguments[0]!;
      } else {
        return current;
      }
    }
  }

  /** The initializer of the `const` an identifier or property names, if in source. */
  private initializer(node: ts.Expression): ts.Expression | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const list = declaration.parent;
      if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) {
        return declaration.initializer;
      }
    }
    if (declaration && ts.isPropertyAssignment(declaration)) return declaration.initializer;
    return undefined;
  }

  /** The one string an expression evaluates to (a group, a dead-letter topic). */
  string(node: ts.Expression): string | undefined {
    const values = this.strings(node, 'scalar');
    return values && values.length === 1 ? values[0] : undefined;
  }

  /**
   * Every string an expression can be: a scalar's possible values, or an
   * array's possible elements. `undefined` when it cannot be evaluated.
   */
  strings(node: ts.Expression, shape: 'scalar' | 'array', depth = 0): string[] | undefined {
    if (depth > 20) return undefined;
    const expr = this.unwrap(node);

    if (shape === 'scalar') {
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
      if (ts.isTemplateExpression(expr)) {
        let results = [expr.head.text];
        for (const span of expr.templateSpans) {
          const values = this.strings(span.expression, 'scalar', depth + 1);
          if (!values) return undefined;
          results = results.flatMap((prefix) =>
            values.map((value) => prefix + value + span.literal.text),
          );
        }
        return results;
      }
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        // `env.X ?? DEFAULT`: an operator's value is validated by the service's
        // env schema; what the repository fixes is the default.
        if (ts.isPropertyAccessExpression(expr.left) && expr.left.expression.getText() === 'env') {
          return this.strings(expr.right, 'scalar', depth + 1);
        }
        return undefined;
      }
      const typed = this.literals(this.checker.getTypeAtLocation(expr));
      if (typed) return typed;
    } else {
      if (ts.isArrayLiteralExpression(expr)) {
        const values: string[] = [];
        for (const element of expr.elements) {
          const part = ts.isSpreadElement(element)
            ? this.strings(element.expression, 'array', depth + 1)
            : this.strings(element, 'scalar', depth + 1);
          if (!part) return undefined;
          values.push(...part);
        }
        return values;
      }
      const type = this.checker.getTypeAtLocation(expr);
      if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
        const elements = this.checker.getTypeArguments(type as ts.TypeReference);
        const values: string[] = [];
        for (const element of elements) {
          const literals = this.literals(element);
          if (!literals) {
            values.length = 0;
            break;
          }
          values.push(...literals);
        }
        if (values.length > 0) return [...new Set(values)];
      }
    }

    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
      const initializer = this.initializer(expr);
      if (initializer) return this.strings(initializer, shape, depth + 1);
    }
    return undefined;
  }
}

function isFromPackage(declaration: ts.Declaration | undefined, fragment: string): boolean {
  return declaration?.getSourceFile().fileName.replace(/\\/g, '/').includes(fragment) ?? false;
}

function isEventConsumerType(type: ts.Type | undefined): boolean {
  const symbol = type?.getSymbol();
  return (
    symbol?.getName() === 'EventConsumer' &&
    (symbol.getDeclarations() ?? []).some((d) => isFromPackage(d, 'packages/nest-common/'))
  );
}

function isKafkaClientType(type: ts.Type): boolean {
  const symbol = type.getSymbol();
  return (
    symbol?.getName() === 'Kafka' &&
    (symbol.getDeclarations() ?? []).some((d) => isFromPackage(d, '/kafkajs/'))
  );
}

/**
 * Scans services' production sources. `overrides` replaces or adds files in
 * memory (the mutation checks below); `only` limits the services scanned.
 */
function scanConsumers(
  options: { overrides?: Record<string, string>; only?: string[]; oldProgram?: ts.Program } = {},
): ScanResult & { program: ts.Program } {
  const overrides = new Map(
    Object.entries(options.overrides ?? {}).map(([path, text]) => [resolve(REPO, path), text]),
  );
  const byService = serviceSources();
  for (const path of overrides.keys()) {
    const service = relative(SERVICES, path).split(/[\\/]/)[0]!;
    const files = byService.get(service);
    if (files && !files.includes(path)) files.push(path);
  }
  const services = [...byService.keys()].filter((s) => !options.only || options.only.includes(s));
  const roots = services.flatMap((service) => byService.get(service)!);

  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => overrides.get(resolve(file)) ?? read(file);
  host.fileExists = (file) => overrides.has(resolve(file)) || exists(file);
  host.getSourceFile = (file, language, onError, create) => {
    const text = overrides.get(resolve(file));
    return text === undefined
      ? getSourceFile(file, language, onError, create)
      : ts.createSourceFile(file, text, language, true);
  };

  const program = ts.createProgram(roots, COMPILER_OPTIONS, host, options.oldProgram);
  const checker = program.getTypeChecker();
  const evaluator = new Evaluator(checker);
  const consumers: FoundConsumer[] = [];
  const violations: string[] = [];

  for (const service of services) {
    for (const path of byService.get(service)!) {
      const source = program.getSourceFile(path);
      if (!source) continue;
      const file = relative(REPO, path);
      const where = (node: ts.Node) =>
        `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node) && isEventConsumerType(checker.getTypeAtLocation(node))) {
          consumers.push(readOptions(service, file, node.arguments?.[0], evaluator, checker));
        }
        if (ts.isClassLike(node)) {
          for (const clause of node.heritageClauses ?? []) {
            for (const base of clause.types) {
              if (isEventConsumerType(checker.getTypeAtLocation(base))) {
                violations.push(`${where(base)}: extends EventConsumer — construct one instead`);
              }
            }
          }
        }
        const accessed =
          ts.isPropertyAccessExpression(node) && node.name.text === 'consumer'
            ? node.expression
            : ts.isElementAccessExpression(node) &&
                ts.isStringLiteralLike(node.argumentExpression) &&
                node.argumentExpression.text === 'consumer'
              ? node.expression
              : undefined;
        if (accessed && isKafkaClientType(checker.getTypeAtLocation(accessed))) {
          violations.push(
            `${where(node)}: a kafkajs consumer outside EventConsumer — nothing checks it against TOPIC_CONSUMERS`,
          );
        }
        if (
          ts.isBindingElement(node) &&
          (node.propertyName ?? node.name).getText() === 'consumer' &&
          ts.isObjectBindingPattern(node.parent) &&
          ts.isVariableDeclaration(node.parent.parent) &&
          node.parent.parent.initializer &&
          isKafkaClientType(checker.getTypeAtLocation(node.parent.parent.initializer))
        ) {
          violations.push(`${where(node)}: a kafkajs consumer outside EventConsumer`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return { consumers, violations, program };
}

function readOptions(
  service: string,
  file: string,
  argument: ts.Expression | undefined,
  evaluator: Evaluator,
  checker: ts.TypeChecker,
): FoundConsumer {
  const found: FoundConsumer = {
    service,
    file,
    groupId: undefined,
    topics: undefined,
    deadLetterTopic: undefined,
  };
  if (!argument) return found;
  let literal: ts.Expression = argument;
  if (ts.isIdentifier(literal)) {
    const symbol = checker.getSymbolAtLocation(literal);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      literal = declaration.initializer;
    }
  }
  if (!ts.isObjectLiteralExpression(literal)) {
    // A parameter or a computed value: nothing to hold against the contract.
    found.deadLetterTopic = null;
    return found;
  }
  const property = (name: string): ts.Expression | undefined => {
    for (const element of literal.properties) {
      if (ts.isPropertyAssignment(element) && element.name.getText() === name) {
        return element.initializer;
      }
      if (ts.isShorthandPropertyAssignment(element) && element.name.text === name) {
        return element.name;
      }
    }
    return undefined;
  };
  const group = property('groupId');
  const topics = property('topics');
  const dlq = property('deadLetterTopic');
  found.groupId = group && evaluator.string(group);
  found.topics = topics && evaluator.strings(topics, 'array');
  if (dlq && !(ts.isIdentifier(dlq) && dlq.text === 'undefined')) {
    found.deadLetterTopic = evaluator.string(dlq) ?? null;
  }
  return found;
}

function problemsOf(
  consumers: FoundConsumer[],
  declarationProblem: typeof consumerDeclarationProblem = consumerDeclarationProblem,
): string[] {
  const problems: string[] = [];
  for (const consumer of consumers) {
    if (
      consumer.groupId === undefined ||
      consumer.topics === undefined ||
      consumer.deadLetterTopic === null
    ) {
      problems.push(`${consumer.file}: cannot evaluate ${JSON.stringify(consumer)}`);
      continue;
    }
    const problem = declarationProblem(consumer.service, {
      groupId: consumer.groupId,
      topics: consumer.topics,
      ...(consumer.deadLetterTopic ? { deadLetterTopic: consumer.deadLetterTopic } : {}),
    });
    if (problem) problems.push(`${consumer.file}: ${problem}`);
  }
  return problems;
}

describe('every Kafka consumer in the repository is a declared EventConsumer', () => {
  let scan: ReturnType<typeof scanConsumers>;

  beforeAll(() => {
    scan = scanConsumers();
  }, 180_000);

  it('finds the consumers it is meant to check', () => {
    // A scanner that found nothing would pass everything.
    expect(scan.consumers.length).toBeGreaterThanOrEqual(Object.keys(TOPIC_CONSUMERS).length);
  });

  it('declares exactly the services that run a consumer', () => {
    const running = [...new Set(scan.consumers.map((consumer) => consumer.service))].sort();
    expect(running).toEqual(Object.keys(TOPIC_CONSUMERS).sort());
  });

  it('evaluates and holds each one to its service’s declaration', () => {
    expect(problemsOf(scan.consumers)).toEqual([]);
  });

  it('finds no Kafka consumer built outside EventConsumer', () => {
    expect(scan.violations).toEqual([]);
  });

  it('takes audit-service’s derived domain topics at their type: every topic they can hold', () => {
    const projector = scan.consumers.find(
      (consumer) =>
        consumer.service === 'audit-service' && consumer.groupId?.endsWith('.domain-projector'),
    );
    expect(projector?.topics?.length).toBeGreaterThanOrEqual(10);
    expect(projector?.topics).not.toContain('rasta.audit.trail.v1');
  });

  /**
   * Mutation checks (#128 review, finding 2): each escape the old text scan
   * missed, made in memory against a real service, must be caught.
   */
  describe('catches each way around it', () => {
    const FLEET_MODULE = 'services/fleet-service/src/app.module.ts';
    const AUDIT_MODULE = 'services/audit-service/src/app.module.ts';
    const read = (path: string) => ts.sys.readFile(join(REPO, path)) ?? '';
    const mutate = (only: string, overrides: Record<string, string>) =>
      scanConsumers({ only: [only], overrides, oldProgram: scan.program });

    it('an aliased import', () => {
      const text = read(FLEET_MODULE)
        .replace(/\bEventConsumer,/, 'EventConsumer as Consumer,')
        .replace('new EventConsumer(', 'new Consumer(')
        .replace("groupId: 'fleet-service.asset-sync'", "groupId: 'economic-service.stolen'");
      expect(text).toContain('new Consumer(');
      const result = mutate('fleet-service', { [FLEET_MODULE]: text });
      expect(result.consumers).toHaveLength(1);
      expect(problemsOf(result.consumers).join('\n')).toMatch(/outside fleet-service's namespace/);
    }, 60_000);

    it('a namespace import', () => {
      const text = `import * as common from '@rasta/nest-common';
export const sneaky = new common.EventConsumer(
  { brokers: ['b'], clientId: 'c', groupId: 'fleet-service.x', topics: ['rasta.economic.v1'] },
  async () => undefined,
  { log: () => undefined, warn: () => undefined, error: () => undefined },
);
`;
      const result = mutate('fleet-service', { 'services/fleet-service/src/sneaky.ts': text });
      expect(problemsOf(result.consumers).join('\n')).toMatch(
        /does not declare a subscription to rasta\.economic\.v1/,
      );
    }, 60_000);

    it('a helper whose options arrive as a parameter', () => {
      const text = `import { EventConsumer, type EventConsumerOptions } from '@rasta/nest-common';
export function make(options: EventConsumerOptions) {
  return new EventConsumer(options, async () => undefined, {
    log: () => undefined, warn: () => undefined, error: () => undefined,
  });
}
`;
      const result = mutate('fleet-service', { 'services/fleet-service/src/factory.ts': text });
      expect(problemsOf(result.consumers).join('\n')).toMatch(/factory\.ts: cannot evaluate/);
    }, 60_000);

    it('a direct kafkajs consumer', () => {
      const text = `import { Kafka } from 'kafkajs';
const kafka = new Kafka({ clientId: 'fleet', brokers: ['b:9092'] });
export const direct = kafka.consumer({ groupId: 'fleet-service.direct' });
export const { consumer: destructured } = kafka;
`;
      const result = mutate('fleet-service', { 'services/fleet-service/src/direct.ts': text });
      expect(result.violations).toHaveLength(2);
      expect(result.violations[0]).toMatch(
        /direct\.ts:3: a kafkajs consumer outside EventConsumer/,
      );
    }, 60_000);

    it('a subclass', () => {
      const text = `import { EventConsumer } from '@rasta/nest-common';
export class Quiet extends EventConsumer {}
`;
      const result = mutate('fleet-service', { 'services/fleet-service/src/quiet.ts': text });
      expect(result.violations.join('\n')).toMatch(/quiet\.ts:2: extends EventConsumer/);
    }, 60_000);

    it('audit’s derived topics drifting from its declaration', () => {
      // An extra topic added to the derived list …
      const text = read(AUDIT_MODULE).replace(
        'topics: [...DOMAIN_TOPICS]',
        "topics: [...DOMAIN_TOPICS, 'rasta.contract.v1']",
      );
      expect(text).toContain("'rasta.contract.v1'");
      const result = mutate('audit-service', { [AUDIT_MODULE]: text });
      expect(problemsOf(result.consumers).join('\n')).toMatch(
        /does not declare a subscription to rasta\.contract\.v1/,
      );
      // … and a declaration narrower than what the derived list can hold.
      const narrowed: typeof consumerDeclarationProblem = (service, consumer) =>
        service === 'audit-service' && consumer.topics.includes('rasta.document.v1')
          ? 'audit-service does not declare a subscription to rasta.document.v1'
          : consumerDeclarationProblem(service, consumer);
      expect(problemsOf(scan.consumers, narrowed).join('\n')).toMatch(/rasta\.document\.v1/);
    }, 60_000);
  });

  it('would catch an undeclared subscription, group or dead-letter topic', () => {
    // The declaration check is only as good as its refusals; these are its three.
    expect(
      consumerDeclarationProblem('fleet-service', {
        groupId: 'fleet-service.asset-sync',
        topics: ['rasta.economic.v1'],
      }),
    ).toBeDefined();
    expect(
      consumerDeclarationProblem('fleet-service', { groupId: 'economic-service.x', topics: [] }),
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
