import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VersioningType, type INestApplication, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { documentationModuleFor } from '@rasta/nest-common';
import { AppModule } from '../app.module';
import { REPAIR_ORDER_ENDPOINTS } from '../maintenance/repair-order.controller';
import { CREATE_REQUEST_ENDPOINT } from '../maintenance/request.controller';
import { enrichOpenApiDocument } from './document';

type Parameter = { name: string; in: string; required?: boolean; schema?: unknown };
type Operation = {
  parameters?: Parameter[];
  responses: Record<string, { description: string }>;
};

/**
 * FU-171: the published replay-deadline header (this service publishes its document at runtime only,
 * docs/api/README.md), and the two things that keep it honest: only the one entry point reads a key,
 * and a browser may send what is published (PR-844 r1 F2).
 */
describe('the published replay deadline (FU-171)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) as Type[];

  beforeAll(async () => {
    app = await NestFactory.create(documentationModuleFor(controllers), { logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    document = enrichOpenApiDocument(
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('t').addBearerAuth().build(),
      ),
    );
  });
  afterAll(() => app.close());

  const operations = () =>
    Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods as Record<string, Operation>)
        .filter(([, operation]) => typeof operation === 'object' && 'responses' in operation)
        .map(([method, operation]) => ({
          name: `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`,
          operation,
        })),
    );
  const headersOf = (operation: Operation) =>
    (operation.parameters ?? []).filter((parameter) => parameter.in === 'header');

  it('is offered on exactly the keyed commands, optional, in its canonical form', () => {
    const keyed = operations().filter(({ operation }) =>
      headersOf(operation).some((header) => header.name === 'Idempotency-Key'),
    );
    expect(keyed.map(({ name }) => name).sort()).toEqual(
      [CREATE_REQUEST_ENDPOINT, ...Object.values(REPAIR_ORDER_ENDPOINTS)].sort(),
    );
    for (const { name, operation } of keyed) {
      expect([
        name,
        headersOf(operation).filter((header) => header.name === 'Idempotency-Replay-Deadline'),
      ]).toEqual([
        name,
        [
          expect.objectContaining({
            required: false,
            schema: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
          }),
        ],
      ]);
      expect(operation.responses['409']?.description).toContain('REPLAY_WINDOW_CLOSED');
      expect(operation.responses['400']?.description).toContain('Idempotency-Replay-Deadline');
    }
    for (const { name, operation } of operations()) {
      if (keyed.some((command) => command.name === name)) continue;
      expect([name, headersOf(operation).map((header) => header.name)]).toEqual([name, []]);
      expect(operation.responses['409']?.description ?? '').not.toContain('REPLAY_WINDOW_CLOSED');
    }
  });

  it('lets a browser send every header a command publishes (PR-844 r1 F2)', () => {
    const policy = /allowedHeaders:\s*\[([^\]]*)\]/.exec(
      readFileSync(join(__dirname, '..', 'main.ts'), 'utf8'),
    )?.[1];
    const published = new Set(
      operations().flatMap(({ operation }) =>
        headersOf(operation).map((header) => header.name.toLowerCase()),
      ),
    );
    expect(published).toContain('idempotency-replay-deadline');
    for (const header of published) expect(policy).toContain(`'${header}'`);
  });

  it('no controller reads a key by itself: the header goes through the one entry point', () => {
    const directory = join(__dirname, '..', 'maintenance');
    const sources = readdirSync(directory).filter((file) => file.endsWith('.controller.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const source = readFileSync(join(directory, file), 'utf8');
      // The lower-case name is how a header is read, by `@Headers(…)` or off `@Req()` alike.
      expect([file, /['"`]idempotency-/.test(source)]).toEqual([file, false]);
    }
  });
});
