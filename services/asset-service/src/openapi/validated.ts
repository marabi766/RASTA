import { Body, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { zodPipe } from '@rasta/nest-common';
import type { z } from 'zod';
import { parametersOf } from './query-parameters';
import { bodyFromSchema } from './request-body';

/**
 * `@Body` validated by `schema` **and** published as `schema` — one registration, so a route cannot
 * validate a body the document does not describe (FU-078 r1 F1: eleven routes validated a body
 * with `@Body(zodPipe(…))` and published none, because the `@ApiBody` beside it was a second,
 * forgettable decorator). `document.spec.ts` enumerates the validating pipes of every route the
 * application really serves and holds each to what is published, so a bare `@Body(zodPipe(…))`
 * fails there too.
 */
export function ValidatedBody(schema: z.ZodType): ParameterDecorator {
  return (target, key, index) => {
    Body(zodPipe(schema))(target, key, index);
    ApiBody(bodyFromSchema(schema))(target, key as string | symbol, methodOf(target, key));
  };
}

/** `@Query` validated by `schema` and published as its parameters, from the one registration. */
export function ValidatedQuery(schema: z.ZodObject): ParameterDecorator {
  return (target, key, index) => {
    Query(zodPipe(schema))(target, key, index);
    const descriptor = methodOf(target, key);
    for (const parameter of parametersOf(schema)) {
      ApiQuery(parameter)(target, key as string | symbol, descriptor);
    }
  };
}

/** The method a parameter decorator sits on; a constructor parameter has none, and is refused. */
function methodOf(target: object, key: string | symbol | undefined): PropertyDescriptor {
  const descriptor = key === undefined ? undefined : Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor)
    throw new Error('ValidatedBody/ValidatedQuery decorate a route handler parameter');
  return descriptor;
}
