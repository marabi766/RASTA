import 'reflect-metadata';
import {
  Body,
  Controller,
  Module,
  Post,
  Query,
  Get,
  type INestApplicationContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { zodPipe } from '../pipes/zod-validation.pipe';
import { toJsonSchema } from './zod-schema';
import {
  publishZodRouteInputs,
  zodRouteInputProblems,
  zodRouteInputs,
  type RouteDocument,
} from './zod-route-inputs';

const bodySchema = z.object({ parentId: z.string().regex(/^ORG_[0-9]+$/) }).strict();
const querySchema = z.object({
  limit: z
    .string()
    .regex(/^[0-9]+$/)
    .optional(),
  q: z.string(),
});

@Controller('things')
class ThingController {
  @Post()
  create(@Body(zodPipe(bodySchema)) _dto: unknown) {}

  @Get()
  list(@Query(zodPipe(querySchema)) _query: unknown) {}
}

@Module({ controllers: [ThingController] })
class ThingModule {}

/** What Nest's Swagger publishes for those routes: names and nothing about the inputs. */
const routeDocument = (): RouteDocument & { paths: Record<string, Record<string, any>> } => ({
  paths: {
    '/things': {
      post: { operationId: 'ThingController_create_v1' },
      get: { operationId: 'ThingController_list_v1', parameters: [{ name: 'q', in: 'query' }] },
    },
  },
});

describe('zod route inputs (PR #710 r1 F1)', () => {
  let app: INestApplicationContext;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(ThingModule, { logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds every Zod-validated body and query, and a bare document fails the check', () => {
    const inputs = zodRouteInputs(app);
    expect(inputs.map((i) => `${i.controller}.${i.handler} ${i.kind}`)).toEqual([
      'ThingController.create body',
      'ThingController.list query',
    ]);
    expect(zodRouteInputProblems(routeDocument(), inputs)).toEqual([
      'ThingController.create body: not published as the converter writes its schema',
      'ThingController.list query: not published as the converter writes its schema',
    ]);
  });

  it('publishes the body and each query field from the schema, replacing a same-name parameter', () => {
    const document = publishZodRouteInputs(app, routeDocument());
    expect(document.paths['/things']!.post.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: toJsonSchema(bodySchema) } },
    });
    expect(document.paths['/things']!.get.parameters).toEqual([
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: toJsonSchema(querySchema.shape.limit),
      },
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
    ]);
    expect(zodRouteInputProblems(document, zodRouteInputs(app))).toEqual([]);
  });

  it('flags an exception once its route is published, and one that names no route', () => {
    const document = publishZodRouteInputs(app, routeDocument());
    expect(
      zodRouteInputProblems(document, zodRouteInputs(app), {
        'ThingController.create body': 'pending',
        'GoneController.x body': 'pending',
      }),
    ).toEqual([
      'GoneController.x body: exception names no Zod-validated route input',
      'ThingController.create body: published now — remove the exception',
    ]);
  });

  it('refuses a route no single operation carries', () => {
    const document = routeDocument();
    document.paths['/things']!.post.operationId = 'Other_create';
    expect(() => publishZodRouteInputs(app, document)).toThrow(
      'ThingController.create body: no single operation publishes it',
    );
    expect(zodRouteInputProblems(document, zodRouteInputs(app))).toContain(
      'ThingController.create body: no single operation publishes it',
    );
  });
});
