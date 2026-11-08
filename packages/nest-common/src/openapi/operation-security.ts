import { Module, type INestApplication, type Type } from '@nestjs/common';
import { PARAMTYPES_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { ALLOW_SERVICE_KEY, IS_PUBLIC_KEY } from '../decorators';
import type { PublishedDocument } from './published-body';

/**
 * The published `security` of every operation, from the metadata `AuthGuard`
 * decides on — never from the path (FU-075, after construction's FU-008).
 *
 * The guard admits, per handler (handler metadata over class metadata):
 * - `@Public` — anyone; published as `security: []`.
 * - `@AllowService(...)` — a service token from a named service, and a user
 *   token as well unless the service itself refuses users on that route.
 * - anything else — a user token only.
 *
 * Whether the service refuses users on a service route is code no decorator
 * states, so each service lists its service routes in a table; the table and
 * the decorators must agree exactly, or nothing is published.
 */
export const BEARER_SCHEME = 'bearer';
export const INTERNAL_TOKEN_SCHEME = 'internalToken';

/** Whether a user token is still admitted on an `@AllowService` route. */
export type ServiceRouteUsers = 'users-accepted' | 'users-refused';

/** What the guard reads for one handler. `services` undefined: no `@AllowService`. */
export interface RouteAccess {
  readonly public: boolean;
  readonly services: readonly string[] | undefined;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

const INTERNAL_TOKEN_SECURITY_SCHEME = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Internal-Token',
  description:
    'A platform service’s internal token (ADR-020, ADR-035), signed for the organization it ' +
    'acts for, sent without an `Authorization` header: a request carrying both is judged on ' +
    'the bearer token, as a user. Admitted only where the route names the calling service.',
} as const;

/**
 * `operationId` (Nest's `Controller_method`) → what the guard reads for that
 * handler, with the guard's own precedence. Fails closed on two handlers that
 * would share an operationId.
 */
export function routeAccessByOperation(app: INestApplication): Map<string, RouteAccess> {
  const reflector = new Reflector();
  const result = new Map<string, RouteAccess>();
  const handlers = new Map<string, unknown>();
  for (const nestModule of app.get(ModulesContainer).values()) {
    for (const { metatype } of nestModule.controllers.values()) {
      if (typeof metatype !== 'function') continue;
      for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
        const handler: unknown = (metatype.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        const id = `${metatype.name}_${name}`;
        if (handlers.has(id) && handlers.get(id) !== handler) {
          throw new Error(`OpenAPI: two handlers named ${id}`);
        }
        handlers.set(id, handler);
        type Target = Parameters<Reflector['getAllAndOverride']>[1][number];
        const targets: [Target, Target] = [handler as Target, metatype as Target];
        result.set(id, {
          public:
            reflector.getAllAndOverride<{ public?: boolean } | undefined>(IS_PUBLIC_KEY, targets)
              ?.public === true,
          services: reflector.getAllAndOverride<string[] | undefined>(ALLOW_SERVICE_KEY, targets),
        });
      }
    }
  }
  return result;
}

type SecurityDocument = PublishedDocument & {
  components?: { securitySchemes?: Record<string, unknown> };
};

/**
 * Assigns `security` to every operation from `access`, and declares the
 * internal-token scheme. Throws — nothing half-published — on an operation
 * with no operationId or no handler, an empty `@AllowService` (the guard
 * would admit every service), `@Public` together with `@AllowService`, an
 * `@AllowService` route missing from `serviceRoutes`, or an entry there for a
 * route that has none or does not exist.
 */
export function applyOperationSecurity<T extends SecurityDocument>(
  document: T,
  access: ReadonlyMap<string, RouteAccess>,
  serviceRoutes: Readonly<Record<string, ServiceRouteUsers>>,
): T {
  const schemes = (document.components ??= {}) as { securitySchemes?: Record<string, unknown> };
  schemes.securitySchemes ??= {};
  if (schemes.securitySchemes[BEARER_SCHEME] === undefined) {
    throw new Error(`OpenAPI: the ${BEARER_SCHEME} scheme is not declared (addBearerAuth)`);
  }
  schemes.securitySchemes[INTERNAL_TOKEN_SCHEME] = INTERNAL_TOKEN_SECURITY_SCHEME;

  const unseen = new Set(Object.keys(serviceRoutes));
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const [method, value] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const operation = value as { operationId?: unknown; security?: unknown };
      if (typeof operation.operationId !== 'string') {
        throw new Error(`OpenAPI: ${key} has no operationId to find its handler by`);
      }
      const route = access.get(operation.operationId.replace(/_v\d+$/, ''));
      if (route === undefined) throw new Error(`OpenAPI: no handler found for ${key}`);
      const users = serviceRoutes[key];
      unseen.delete(key);
      if (route.services?.length === 0) {
        throw new Error(`OpenAPI: ${key} has an empty @AllowService; name its callers`);
      }
      if (route.public && route.services !== undefined) {
        throw new Error(`OpenAPI: ${key} is both @Public and @AllowService`);
      }
      if ((route.services === undefined) !== (users === undefined)) {
        throw new Error(`OpenAPI: ${key} and the service-route table disagree about @AllowService`);
      }
      // Assigned, not defaulted: a Swagger decorator never outranks the guard's metadata.
      operation.security = route.public
        ? []
        : [
            ...(users === 'users-refused' ? [] : [{ [BEARER_SCHEME]: [] }]),
            ...(route.services ? [{ [INTERNAL_TOKEN_SCHEME]: [] }] : []),
          ];
    }
  }
  if (unseen.size > 0) {
    throw new Error(`OpenAPI: service-route table names no such route: ${[...unseen].join(', ')}`);
  }
  return document;
}

/**
 * A module holding only `controllers`, every constructor dependency stubbed:
 * what a generator or a route-coverage test boots to read the routes and their
 * guard metadata without a database, broker or credentials.
 */
export function documentationModuleFor(controllers: readonly Type[]): Type {
  const tokens = new Set<unknown>();
  for (const controller of controllers) {
    const types = (Reflect.getMetadata(PARAMTYPES_METADATA, controller) ?? []) as unknown[];
    for (const token of types) tokens.add(token);
    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, controller) ?? []) as {
      param: unknown;
    }[];
    for (const { param } of declared) tokens.add(param);
  }
  @Module({
    controllers: [...controllers],
    providers: [...tokens].map((provide) => ({ provide: provide as Type, useValue: {} })),
  })
  class DocumentationModule {}
  return DocumentationModule;
}
