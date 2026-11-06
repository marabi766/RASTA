import 'reflect-metadata';
import { Controller, Get, Inject, Post, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AllowService, Public } from '../decorators';
import {
  applyOperationSecurity,
  documentationModuleFor,
  routeAccessByOperation,
  type RouteAccess,
} from './operation-security';

class Dependency {}
const TOKEN = Symbol('token');

@Controller('things')
class ThingController {
  constructor(
    readonly dependency: Dependency,
    @Inject(TOKEN) readonly token: unknown,
  ) {}
  @Get()
  list(): void {}
  @Post()
  @AllowService('a-service')
  create(): void {}
  @Get('open')
  @Public('probe')
  open(): void {}
}

@Controller('internal')
@AllowService('class-service')
class ClassLevelController {
  @Get()
  read(): void {}
  @Post()
  @AllowService('handler-service')
  write(): void {}
}

const doc = (ops: Record<string, Record<string, unknown>>) => ({
  paths: ops,
  components: { securitySchemes: { bearer: { type: 'http' } } },
});
const op = (operationId?: string) => (operationId === undefined ? {} : { operationId });

describe('operation security from guard metadata (FU-075)', () => {
  let app: INestApplication;
  let access: Map<string, RouteAccess>;
  beforeAll(async () => {
    app = await NestFactory.create(
      documentationModuleFor([ThingController, ClassLevelController]),
      {
        logger: false,
      },
    );
    access = routeAccessByOperation(app);
  });
  afterAll(() => app.close());

  it('reads handler metadata over class metadata, as AuthGuard does', () => {
    expect(access.get('ThingController_list')).toEqual({ public: false, services: undefined });
    expect(access.get('ThingController_create')?.services).toEqual(['a-service']);
    expect(access.get('ThingController_open')?.public).toBe(true);
    expect(access.get('ClassLevelController_read')?.services).toEqual(['class-service']);
    expect(access.get('ClassLevelController_write')?.services).toEqual(['handler-service']);
  });

  it('assigns bearer, internal token, both, or none per operation', () => {
    const out = applyOperationSecurity(
      doc({
        '/v1/things': {
          get: { ...op('ThingController_list_v1'), security: [{ internalToken: [] }] },
          post: op('ThingController_create_v1'),
        },
        '/v1/things/open': { get: op('ThingController_open') },
        '/v1/internal': { get: op('ClassLevelController_read_v1') },
      }),
      access,
      { 'POST /v1/things': 'users-accepted', 'GET /v1/internal': 'users-refused' },
    );
    const sec = (p: string, m: string) =>
      ((out.paths[p] as Record<string, { security: unknown }>)[m] ?? { security: 'missing' })
        .security;
    // Assigned, not defaulted: a pre-set value does not survive.
    expect(sec('/v1/things', 'get')).toEqual([{ bearer: [] }]);
    expect(sec('/v1/things', 'post')).toEqual([{ bearer: [] }, { internalToken: [] }]);
    expect(sec('/v1/things/open', 'get')).toEqual([]);
    expect(sec('/v1/internal', 'get')).toEqual([{ internalToken: [] }]);
    expect(out.components.securitySchemes).toHaveProperty('internalToken');
  });

  it.each([
    ['no operationId', { '/x': { get: op() } }, {}, /no operationId/],
    ['an unknown handler', { '/x': { get: op('Nope_get') } }, {}, /no handler found/],
    [
      'an @AllowService route missing from the table',
      { '/x': { post: op('ThingController_create') } },
      {},
      /disagree/,
    ],
    [
      'a table entry on a route with no @AllowService',
      { '/x': { get: op('ThingController_list') } },
      { 'GET /x': 'users-accepted' },
      /disagree/,
    ],
    ['a stale table entry', {}, { 'GET /gone': 'users-refused' }, /names no such route/],
  ] as const)('refuses %s', (_name, paths, table, error) => {
    expect(() => applyOperationSecurity(doc(paths), access, table)).toThrow(error);
  });

  it('refuses an empty allowlist, @Public with @AllowService, and an undeclared bearer scheme', () => {
    const route = (value: RouteAccess) => new Map([['C_m', value]]);
    const paths = { '/x': { get: op('C_m') } };
    expect(() =>
      applyOperationSecurity(doc(paths), route({ public: false, services: [] }), {
        'GET /x': 'users-accepted',
      }),
    ).toThrow(/empty @AllowService/);
    expect(() =>
      applyOperationSecurity(doc(paths), route({ public: true, services: ['s'] }), {
        'GET /x': 'users-accepted',
      }),
    ).toThrow(/both @Public and @AllowService/);
    expect(() =>
      applyOperationSecurity({ paths }, route({ public: false, services: undefined }), {}),
    ).toThrow(/bearer scheme is not declared/);
  });
});
