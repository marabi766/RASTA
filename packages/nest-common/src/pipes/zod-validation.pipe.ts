import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { ErrorDetail } from '@rasta/contracts';
import { RastaError } from '../errors/rasta-error';

/**
 * Validates and parses a request payload against a Zod schema.
 *
 * The same schemas back the OpenAPI document and the frontend forms, so a
 * field cannot drift between what the client sends, what the server accepts
 * and what the docs promise.
 *
 * Errors are reported with a field path, so a client can highlight the offending
 * input rather than showing "invalid request" over a twenty-field form.
 */
@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw RastaError.validation(toErrorDetails(error));
      }
      throw error;
    }
  }
}

/** Convenience for inline use: `@Body(zodPipe(createAssetSchema)) dto: CreateAssetDto`. */
export function zodPipe<T extends ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

export function toErrorDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: formatPath(issue.path),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Renders a Zod path the way a client would address it:
 * `['items', 0, 'quantity']` becomes `items[0].quantity`.
 */
export function formatPath(path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return '(root)';

  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    const key = String(segment);
    return acc.length === 0 ? key : `${acc}.${key}`;
  }, '');
}
