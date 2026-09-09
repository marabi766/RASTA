import { Inject, Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { RastaError, toErrorDetails } from '@rasta/nest-common';
import { ENV } from '../tokens';
import type { AuditEnv } from '../config/env';
import {
  buildAuditEventDetailQuerySchema,
  buildAuditEventQuerySchema,
  type AuditEventDetailQuery,
  type AuditEventQuery,
} from './audit.query.dto';

/**
 * Query validation, as a pipe rather than as a check inside the service.
 *
 * ## Why a pipe, and why an injectable one
 *
 * ADR-053 § 10 requires an over-wide window to cost no query at all. A pipe is
 * how that becomes structural instead of conventional: Nest runs it before the
 * handler is entered, so there is no ordering for a future edit to get wrong —
 * a handler either receives an already-valid value or is never called.
 *
 * `ZodValidationPipe` from `@rasta/nest-common` would do the parsing, but it is
 * constructed with a schema at decoration time and this schema is not knowable
 * then: the window ceiling is `AUDIT_MAX_QUERY_WINDOW_DAYS`, and the 400 must
 * name the value the deployment actually runs rather than the default. So these
 * two pipes take the validated environment as a constructor dependency and are
 * referenced by class in the controller.
 *
 * ## Why the ceiling is injected rather than passed by a factory provider
 *
 * `@Query(AuditEventQueryPipe)` names a **class**, and Nest resolves a
 * class-referenced enhancer through the module's *injectables* collection,
 * which it builds from the metatype while scanning the controller. A
 * `{ provide: AuditEventQueryPipe, useFactory }` provider sharing that token is
 * simply not consulted, so the container constructs the class itself and has to
 * resolve every constructor parameter. A bare `number` parameter has no token,
 * which is why that arrangement failed at boot with "can't resolve
 * dependencies of the AuditEventQueryPipe (?) … argument Number at index [0]".
 *
 * Injecting `ENV` gives the parameter a token the container can resolve, so the
 * pipe is constructible by the same injector that reaches it from the route.
 * The ceiling still comes from the validated environment — the same value, read
 * one step later.
 *
 * Errors are mapped exactly as the shared pipe maps them, so a client sees one
 * `VALIDATION_FAILED` shape from this service as from every other.
 */
abstract class SchemaQueryPipe<T> implements PipeTransform {
  protected constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) throw RastaError.validation(toErrorDetails(error));
      throw error;
    }
  }
}

@Injectable()
export class AuditEventQueryPipe extends SchemaQueryPipe<AuditEventQuery> {
  constructor(@Inject(ENV) env: AuditEnv) {
    super(buildAuditEventQuerySchema(env.AUDIT_MAX_QUERY_WINDOW_DAYS));
  }
}

@Injectable()
export class AuditEventDetailQueryPipe extends SchemaQueryPipe<AuditEventDetailQuery> {
  constructor(@Inject(ENV) env: AuditEnv) {
    super(buildAuditEventDetailQuerySchema(env.AUDIT_MAX_QUERY_WINDOW_DAYS));
  }
}
