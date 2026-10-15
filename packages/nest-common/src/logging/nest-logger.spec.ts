import 'reflect-metadata';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Injectable, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger, REDACTED } from '@rasta/logging';
import { EXCEPTION_FILTER_LOGGER } from '../filters/exception.filter';
import { bootstrapLogger, installNestLogger, logFatal } from './nest-logger';

/**
 * `new Logger(...)` from `@nestjs/common` is the logger most of the platform
 * writes through; unless the application registers an adapter it prints raw to
 * stdout and none of `@rasta/logging`'s scrubbing or capping applies (Codex on
 * #290, F4). These run a real Nest application context and read what reaches
 * the process's stdout.
 */

const PASSWORD = 'LEAKPASSWORD';
const TOKEN = 'LEAKTOKEN0123456789';
const DSN = `postgresql://app:${PASSWORD}@db.internal:5432/app`;

type Line = Record<string, unknown> & { msg?: string; level?: string };

/**
 * Lines the logger writes to stdout while `work` runs. Under Jest `process.stdout`
 * is replaced, so pino writes through its `write` rather than to fd 1.
 */
async function captureStdout(work: () => Promise<void> | void): Promise<Line[]> {
  const written: string[] = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await work();
  } finally {
    spy.mockRestore();
  }
  return written
    .join('')
    .split('\n')
    .filter((text) => text.startsWith('{'))
    .map((text) => JSON.parse(text) as Line)
    .filter((line) => !['InstanceLoader', 'NestFactory'].includes(String(line.context)));
}

describe('installNestLogger', () => {
  const appLogger = () => createLogger({ serviceName: 'svc-a', level: 'trace', pretty: false });

  /** A service class that logs the way the services do: `new Logger(Name)`. */
  @Injectable()
  class OtherService {
    private readonly logger = new Logger(OtherService.name);
    fail(error: unknown): void {
      this.logger.error({ operation: 'call', err: error }, 'could not be reached');
    }
    say(message: string): void {
      this.logger.log(message);
      this.logger.warn(message);
      this.logger.debug(message);
      this.logger.verbose(message);
    }
    stack(message: string, stack: string): void {
      this.logger.error(message, stack);
    }
  }

  async function run(work: (service: OtherService) => void): Promise<Line[]> {
    // A factory, so pino picks its destination under the stdout spy.
    @Module({
      providers: [OtherService, { provide: EXCEPTION_FILTER_LOGGER, useFactory: appLogger }],
    })
    class AppModule {}

    return captureStdout(async () => {
      const app = await NestFactory.createApplicationContext(AppModule, {
        bufferLogs: true,
        logger: false,
      });
      installNestLogger(app);
      work(app.get(OtherService));
      await app.close();
    });
  }

  it('sends a Nest Logger instance in another service through the app logger, scrubbed', async () => {
    const lines = await run((service) =>
      service.say(`connect failed: ${DSN} Authorization: Bearer ${TOKEN}`),
    );

    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toMatchObject({ service: 'svc-a', context: 'OtherService' });
      expect(JSON.stringify(line)).not.toContain(PASSWORD);
      expect(JSON.stringify(line)).not.toContain(TOKEN);
    }
  });

  it('keeps the level and the context name', async () => {
    const lines = await run((service) => service.say('hello'));

    expect(lines.map((line) => line.level)).toEqual(['info', 'warn', 'debug', 'trace']);
    expect(lines.every((line) => line.context === 'OtherService')).toBe(true);
  });

  it('scrubs an Error, its cause and its stack carried in a structured message', async () => {
    const error = new Error(`getaddrinfo failed for ${DSN}`, {
      cause: new Error(`upstream said Authorization: Bearer ${TOKEN}`),
    });

    const lines = await run((service) => service.fail(error));

    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(TOKEN);
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'could not be reached',
      operation: 'call',
    });
    expect((lines[0].err as { message: string }).message).toContain('getaddrinfo failed');
  });

  it('scrubs the stack Nest passes beside an error message', async () => {
    const lines = await run((service) =>
      service.stack('failed', `Error: x\n    at connect (${DSN})`),
    );

    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
    expect(lines[0].msg).toBe('failed');
  });

  it('scrubs and caps the stack of the static two-argument Logger.error(message, stack)', async () => {
    const stack = `Error: ${DSN}\n    at connect (${DSN})\n${'x'.repeat(200_000)}`;

    const lines = await run(() => Logger.error('failed', stack));

    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
    expect(JSON.stringify(lines[0]).length).toBeLessThan(40_000);
  });

  it('scrubs and caps a context string that carries a secret', async () => {
    const lines = await run((service) =>
      (service as unknown as { logger: Logger }).logger.error(
        'failed',
        undefined,
        DSN.repeat(2000),
      ),
    );

    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
    expect(JSON.stringify(lines[0]).length).toBeLessThan(40_000);
  });

  it('never throws from a log call, whatever the value', async () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
        get: () => {
          throw new Error('trap');
        },
      },
    );
    const lines = await run((service) => {
      const logger = (service as unknown as { logger: Logger }).logger;
      expect(() =>
        logger.error({
          err: {
            get message(): never {
              throw new Error('getter failed');
            },
          },
        }),
      ).not.toThrow();
      expect(() => logger.error('failed', hostile)).not.toThrow();
      expect(() => logger.log(hostile)).not.toThrow();
    });

    expect(JSON.stringify(lines)).not.toContain('getter failed');
  });

  it('caps a very long body', async () => {
    const body = `${'x'.repeat(200_000)} ${DSN}`;

    const lines = await run((service) => service.fail(new Error(body)));

    expect(JSON.stringify(lines[0]).length).toBeLessThan(40_000);
    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
  });

  it('still redacts a sensitive key by name', async () => {
    const lines = await run((service) =>
      (service as unknown as { logger: Logger }).logger.log({ password: 'hunter2', ok: 1 }),
    );

    expect(lines[0].password).toBe(REDACTED);
    expect(lines[0].ok).toBe(1);
  });
});

describe('bootstrapLogger', () => {
  it('writes a provider-construction failure scrubbed, before installNestLogger runs', async () => {
    @Module({
      providers: [
        {
          provide: 'BROKEN',
          useFactory: () => {
            throw new Error(`ENOENT: cannot open ${DSN} Authorization: Bearer ${TOKEN}`);
          },
        },
      ],
    })
    class BrokenModule {}

    const stderr: string[] = [];
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let lines: Line[] = [];
    try {
      lines = await captureStdout(async () => {
        await NestFactory.createApplicationContext(BrokenModule, {
          logger: bootstrapLogger(
            { NODE_ENV: 'test', LOG_LEVEL: 'trace', SERVICE_VERSION: '1' },
            'svc-a',
          ),
          bufferLogs: true,
          abortOnError: false,
        }).catch(() => undefined);
      });
    } finally {
      errSpy.mockRestore();
      exit.mockRestore();
    }

    const text = JSON.stringify(lines) + stderr.join('');
    expect(lines.some((line) => line.level === 'error')).toBe(true);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(TOKEN);
  });
});

describe('every service installs the adapter', () => {
  const servicesDir = resolve(__dirname, '../../../../services');
  const mains = readdirSync(servicesDir)
    .map((name) => join(servicesDir, name, 'src/main.ts'))
    .filter((file) => existsSync(file));

  it('finds the services', () => {
    expect(mains.length).toBeGreaterThanOrEqual(15);
  });

  it.each(mains.map((file) => [relative(servicesDir, file), file]))(
    '%s routes Nest and a startup failure through the logger',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('installNestLogger(app)');
      // The logger exists before the providers do (F4 on #296).
      expect(source).toMatch(
        /NestFactory\.create[\s\S]*?logger: bootstrapLogger\(env, SERVICE_NAME\)/,
      );
      expect(source).not.toMatch(/console\.error\([^)]*failed to start/);
    },
  );
});

describe('logFatal', () => {
  it('writes a startup failure through the logger, scrubbed', async () => {
    const lines = await captureStdout(() =>
      logFatal(
        { serviceName: 'svc-a' },
        '[svc-a] failed to start',
        new Error(`ECONNREFUSED ${DSN}`),
      ),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'fatal', msg: '[svc-a] failed to start' });
    expect(JSON.stringify(lines[0])).not.toContain(PASSWORD);
  });
});
