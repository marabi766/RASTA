import { isDeepStrictEqual } from 'node:util';
import type { INestApplicationContext, Type } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import type { z } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { isOptionalField, objectShapeOf, toJsonSchema } from './zod-schema';

/**
 * The request bodies and query strings a service validates with `zodPipe`, published from the
 * very schema the pipe applies (PR #710 r1 F1).
 *
 * `@nestjs/swagger` sees decorated classes, not Zod: a route that validates
 * `@Body(zodPipe(schema))` was published with no request body at all, so a client was told
 * nothing about a field the runtime refuses. Reading the pipes off the booted application's
 * controllers means a new route is published the moment it validates, with no registry to
 * forget, and {@link zodRouteInputProblems} holds a document to it at the route boundary.
 */
export interface ZodRouteInput {
  readonly controller: string;
  readonly handler: string;
  readonly kind: 'body' | 'query';
  readonly schema: z.ZodType;
}

/** `Controller.handler kind` — how a route input is named in problems and exceptions. */
export const zodRouteInputKey = (input: ZodRouteInput): string =>
  `${input.controller}.${input.handler} ${input.kind}`;

/**
 * Every `@Body(zodPipe(…))` / `@Query(zodPipe(…))` of every controller the application booted.
 * A Zod pipe on one named field (`@Body('x', zodPipe(…))`) cannot be published faithfully as a
 * body or a query, so it is refused rather than skipped.
 */
export function zodRouteInputs(app: INestApplicationContext): ZodRouteInput[] {
  const controllers = new Set<Type>();
  for (const nestModule of app.get(ModulesContainer).values()) {
    for (const wrapper of nestModule.controllers.values()) {
      if (typeof wrapper.metatype === 'function') controllers.add(wrapper.metatype as Type);
    }
  }

  const inputs: ZodRouteInput[] = [];
  for (const controller of controllers) {
    for (const handler of handlersOf(controller)) {
      const args: Record<string, { data?: unknown; pipes?: unknown[] }> =
        Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, handler) ?? {};
      for (const [key, arg] of Object.entries(args)) {
        const type = Number(key.split(':')[0]);
        const kind =
          type === RouteParamtypes.BODY ? 'body' : type === RouteParamtypes.QUERY ? 'query' : null;
        if (!kind) continue;
        for (const pipe of arg.pipes ?? []) {
          if (!(pipe instanceof ZodValidationPipe)) continue;
          if (arg.data !== undefined) {
            throw new Error(
              `${controller.name}.${handler}: a Zod pipe on one ${kind} field cannot be published`,
            );
          }
          inputs.push({ controller: controller.name, handler, kind, schema: pipe.schema });
        }
      }
    }
  }
  return inputs;
}

/**
 * Writes each route input into `document`: the body as `requestBody`, each query field as an
 * `in: query` parameter (replacing one of the same name). Fails when a route has no single
 * operation to carry it, or a query schema is not an object.
 */
export function publishZodRouteInputs<D extends RouteDocument>(
  app: INestApplicationContext,
  document: D,
): D {
  for (const input of zodRouteInputs(app)) {
    const operation = operationOf(document, input);
    if (!operation) throw new Error(`${zodRouteInputKey(input)}: no single operation publishes it`);
    if (input.kind === 'body') {
      operation.requestBody = expectedBody(input.schema);
      continue;
    }
    const parameters = expectedQuery(input.schema);
    if (!parameters) throw new Error(`${zodRouteInputKey(input)}: the query is not an object`);
    const names = new Set(parameters.map((parameter) => parameter.name));
    operation.parameters = [
      ...(operation.parameters ?? []).filter((p) => !(isQuery(p) && names.has(p.name))),
      ...parameters,
    ];
  }
  return document;
}

/**
 * Where `document` does not publish a route input exactly as the converter writes its schema.
 * `exceptions` names inputs that are knowingly unpublished, each with its reason; an exception
 * that is published by now, or that names no route input, is itself a problem, so it cannot
 * outlive the fix.
 */
export function zodRouteInputProblems(
  document: RouteDocument,
  inputs: readonly ZodRouteInput[],
  exceptions: Readonly<Record<string, string>> = {},
): string[] {
  const problems: string[] = [];
  const keys = new Set(inputs.map(zodRouteInputKey));
  for (const key of Object.keys(exceptions)) {
    if (!keys.has(key)) problems.push(`${key}: exception names no Zod-validated route input`);
  }

  for (const input of inputs) {
    const key = zodRouteInputKey(input);
    const operation = operationOf(document, input);
    const published = operation ? isPublished(operation, input) : false;
    if (key in exceptions) {
      if (published) problems.push(`${key}: published now — remove the exception`);
      continue;
    }
    if (!operation) problems.push(`${key}: no single operation publishes it`);
    else if (!published) problems.push(`${key}: not published as the converter writes its schema`);
  }
  return problems;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: unknown;
}

interface RouteOperation {
  operationId?: string;
  requestBody?: unknown;
  parameters?: Parameter[];
}

/** The part of an OpenAPI document this reads and writes; Nest's `OpenAPIObject` satisfies it. */
export interface RouteDocument {
  paths: Record<string, unknown>;
}

function handlersOf(controller: Type): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter(
    (name) => name !== 'constructor' && typeof controller.prototype[name] === 'function',
  );
}

const isQuery = (parameter: Parameter): boolean => parameter.in === 'query';

function expectedBody(schema: z.ZodType) {
  return {
    required: !isOptionalField(schema),
    content: { 'application/json': { schema: toJsonSchema(schema) } },
  };
}

function expectedQuery(schema: z.ZodType): Parameter[] | undefined {
  const shape = objectShapeOf(schema);
  if (!shape) return undefined;
  return Object.entries(shape).map(([name, member]) => ({
    name,
    in: 'query',
    required: !isOptionalField(member),
    schema: toJsonSchema(member),
  }));
}

function isPublished(operation: RouteOperation, input: ZodRouteInput): boolean {
  if (input.kind === 'body')
    return isDeepStrictEqual(operation.requestBody, expectedBody(input.schema));
  const expected = expectedQuery(input.schema);
  if (!expected) return false;
  const query = (operation.parameters ?? []).filter(isQuery);
  return isDeepStrictEqual(
    [...query].sort((a, b) => a.name.localeCompare(b.name)),
    [...expected].sort((a, b) => a.name.localeCompare(b.name)),
  );
}

/**
 * The one operation Nest's default `operationId` names for this handler:
 * `Controller_handler`, with `_v<version>` under URI versioning.
 */
function operationOf(document: RouteDocument, input: ZodRouteInput): RouteOperation | undefined {
  const base = `${input.controller}_${input.handler}`;
  const found: RouteOperation[] = [];
  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values((item ?? {}) as Record<string, RouteOperation>)) {
      const id = operation?.operationId;
      if (typeof id !== 'string') continue;
      if (id === base || (id.startsWith(base) && /^_v[^_]+$/.test(id.slice(base.length)))) {
        found.push(operation);
      }
    }
  }
  return found.length === 1 ? found[0] : undefined;
}
