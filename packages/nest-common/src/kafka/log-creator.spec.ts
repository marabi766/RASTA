import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { logLevel } from 'kafkajs';
import { kafkaClientConfig } from './connection';
import { kafkaLogCreator } from './log-creator';

/**
 * KafkaJS logs through `console` unless given a `logCreator`; a SCRAM failure
 * or a transport error then reaches the output with its text and stack as they
 * are (Codex on #296, F2).
 */

const PASSWORD = 'LEAKPASSWORD';
const DSN = `postgresql://app:${PASSWORD}@db.internal:5432/app`;

type Line = Record<string, unknown> & { msg?: string; level?: string };

function captureStdout(work: () => void): Line[] {
  const written: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    work();
  } finally {
    spy.mockRestore();
  }
  return written
    .join('')
    .split('\n')
    .filter((text) => text.startsWith('{'))
    .map((text) => JSON.parse(text) as Line);
}

describe('kafkaLogCreator', () => {
  const write = (level: number, log: Record<string, unknown>) =>
    captureStdout(() =>
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
  const found: string[] = [];

  function walk(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', 'generated', '.turbo'].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name) && !/\.(spec|int-spec)\.ts$/.test(name)) found.push(path);
    }
  }

  for (const top of ['services', 'packages']) {
    const dir = join(root, top);
    if (existsSync(dir)) walk(dir);
  }

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
