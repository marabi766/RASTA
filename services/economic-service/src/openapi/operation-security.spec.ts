import { operatorDecisionSchema } from '../payment/dto';
import { VersioningType, type INestApplication, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ALLOW_SERVICE_KEY, IS_PUBLIC_KEY, documentationModuleFor } from '@rasta/nest-common';
import { AppModule } from '../app.module';
import { enrichOpenApiDocument, publishOperationSecurity, SERVICE_ROUTES } from './document';

/**
 * FU-075: every operation's published `security` is the guard's decision. The
 * decorators are read here with raw `Reflect.getMetadata` (handler over class,
 * as `AuthGuard` does), not with the generator's reader, so the two cannot
 * agree by construction. The controllers are the real AppModule's.
 */
describe('published security equals the guard decision (FU-075)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;
  const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) as Type[];

  beforeAll(async () => {
    app = await NestFactory.create(documentationModuleFor(controllers), { logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    const built = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').addBearerAuth().build(),
    );
    document = publishOperationSecurity(enrichOpenApiDocument(built), app);
  });
  afterAll(() => app.close());

  it('omits transformed body constraints in the served document (FU-120)', () => {
    const body = JSON.parse(
      JSON.stringify(
        document.paths['/v1/payment-intents/{id}/reconciliation/requeue']!.post!.requestBody,
      ),
    );
    expect(body.content['application/json'].schema.properties.reason).toEqual({
      type: 'string',
      description: expect.stringContaining('Constraints after a value-changing step are omitted'),
    });
    const field = operatorDecisionSchema.shape.reason;
    expect(field.safeParse(' ' + 'a'.repeat(500) + ' ').success).toBe(true);
    expect(field.safeParse('   ').success).toBe(false);
  });

  it('documents bearer, internal token, both or none exactly where the guard admits them', () => {
    const expected = new Map<string, string[]>();
    for (const controller of controllers) {
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const handler = (controller.prototype as Record<string, object>)[name]!;
        const read = (key: string): unknown =>
          Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller);
        const isPublic = (read(IS_PUBLIC_KEY) as { public?: boolean } | undefined)?.public;
        const services = read(ALLOW_SERVICE_KEY) as string[] | undefined;
        expected.set(`${controller.name}_${name}`, [
          ...(isPublic ? [] : ['bearer']),
          ...(services ? ['internalToken'] : []),
        ]);
      }
    }

    const seen: string[] = [];
    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        const op = operation as { operationId: string; security: Record<string, string[]>[] };
        const key = `${method.toUpperCase()} ${path}`;
        let want = expected.get(op.operationId.replace(/_v\d+$/, ''));
        // A user token is refused in the service, not the guard, on these routes.
        if (SERVICE_ROUTES[key] === 'users-refused') want = ['internalToken'];
        expect({ key, security: op.security.flatMap(Object.keys) }).toEqual({
          key,
          security: want,
        });
        if (want?.includes('internalToken')) seen.push(key);
      }
    }
    expect(seen.sort()).toEqual(Object.keys(SERVICE_ROUTES).sort());
    expect(seen.length).toBe(13);
  });
});
