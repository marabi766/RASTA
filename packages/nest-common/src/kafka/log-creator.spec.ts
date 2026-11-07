import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { logLevel } from 'kafkajs';
import { kafkaClientConfig } from './connection';
import { kafkaLogCreator } from './log-creator';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS, shared with the other specs
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

/**
 * KafkaJS logs through `console` unless given a `logCreator`; a SCRAM failure
 * or a transport error then reaches the output with its text and stack as they
 * are (Codex on #296, F2).
 */

/**
 * Every line any `createLogger` writes: the real logger (serialization,
 * scrubbing, caps) with only its destination replaced — it opens fd 1 itself,
 * so a `process.stdout` spy sees nothing (Codex on #296, r2 F2).
 */
const mockWritten: string[] = [];
jest.mock('@rasta/logging', () => {
  const actual = jest.requireActual<typeof import('@rasta/logging')>('@rasta/logging');
  return {
    ...actual,
    createLogger: (config: import('@rasta/logging').LoggerConfig) =>
      actual.createLogger({
        ...config,
        destination: { write: (line: string) => void mockWritten.push(line) },
      }),
  };
});

const PASSWORD = 'LEAKPASSWORD';
const DSN = `postgresql://app:${PASSWORD}@db.internal:5432/app`;

type Line = Record<string, unknown> & { msg?: string; level?: string };

function captureLines(work: () => void): Line[] {
  mockWritten.length = 0;
  work();
  return mockWritten
    .join('')
    .split('\n')
    .filter((text) => text.startsWith('{'))
    .map((text) => JSON.parse(text) as Line);
}

describe('kafkaLogCreator', () => {
  const write = (level: number, log: Record<string, unknown>) =>
    captureLines(() =>
      kafkaLogCreator('svc-kafka')(level)({ namespace: 'Connection', level, log } as never),
    );

  it('scrubs the message and every extra field', () => {
    const lines = write(logLevel.ERROR, {
      timestamp: new Date().toISOString(),
      message: `SASL SCRAM failed for ${DSN}`,
      error: `Error: ${DSN}\n    at connect (${DSN})`,
      cause: { message: `upstream said ${DSN}` },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      component: 'kafkajs',
      namespace: 'Connection',
    });
    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
  });

  it('caps a very long record', () => {
    const lines = write(logLevel.ERROR, {
      message: `${'x'.repeat(200_000)} ${DSN}`,
      stack: `${'y'.repeat(200_000)} ${DSN}`,
    });

    expect(JSON.stringify(lines[0]).length).toBeLessThan(60_000);
    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
  });

  it('never throws on a hostile field', () => {
    expect(() =>
      write(logLevel.ERROR, {
        message: 'x',
        get error(): never {
          throw new Error('getter');
        },
      }),
    ).not.toThrow();
  });

  it('is part of every client configuration', () => {
    const config = kafkaClientConfig({ clientId: 'c', brokers: ['b:9092'] });

    expect(typeof config.logCreator).toBe('function');
  });
});

describe('every Kafka client in the services takes the shared configuration', () => {
  const root = resolve(__dirname, '../../../..');
  // git-ignored output (build output, installs, generated clients) is never listed
  const found = ['services', 'packages']
    .filter((top) => existsSync(join(root, top)))
    .flatMap((top) => authoredFiles(join(root, top)))
    .filter((path) => /\.ts$/.test(path) && !/\.(spec|int-spec)\.ts$/.test(path));

  it.each(
    found
      .filter((file) => /new Kafka\(\{/.test(readFileSync(file, 'utf8')))
      .map((file) => [relative(root, file), file]),
  )('%s spreads kafkaClientConfig', (_name, file) => {
    const source = readFileSync(file, 'utf8');
    const constructions = source.match(/new Kafka\(\{[\s\S]*?\}\)/g) ?? [];
    expect(constructions.length).toBeGreaterThan(0);
    for (const construction of constructions) {
      expect(construction).toContain('...kafkaClientConfig(');
    }
  });
});
