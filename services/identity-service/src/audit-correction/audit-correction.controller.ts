import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Idempotent, Roles, zodPipe } from '@rasta/nest-common';
import {
  AUDIT_CORRECTION_ROLE,
  AuditCorrectionService,
  type AuditCorrectionAccepted,
} from './audit-correction.service';
import { auditCorrectionCommandSchema, type AuditCorrectionCommand } from './dto';

/**
 * `POST /v1/audit-corrections` — the audit correction command (ADR-053 § 7).
 *
 * A top-level prefix routed to identity-service, because the gateway routes on
 * the first path segment and `audit-events` belongs to audit-service, which has
 * no write endpoint and never will (`docs/04` § 4.15). The HTTP shape is a
 * Temporary Decision (`docs/24-open-questions.md` Q-53).
 *
 * HTTP to DTO only. Authority, idempotency, the target lookup and the outbox
 * write are the service's (AGENTS.md A-10).
 */
@ApiTags('audit-corrections')
@Controller({ path: 'audit-corrections', version: '1' })
@Roles(AUDIT_CORRECTION_ROLE)
export class AuditCorrectionController {
  constructor(private readonly corrections: AuditCorrectionService) {}

  @Post()
  @HttpCode(202)
  @Idempotent()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Mandatory. The same key with the same request replays the original `202`; ' +
      'with a different request it is refused with `409 IDEMPOTENCY_KEY_REUSED`.',
  })
  @ApiOperation({
    summary: 'Correct an audit record by appending a linked correction (SYSTEM_ADMIN)',
    description:
      'Never edits the original. Enqueues one `AUDIT_EVENT_RECORDED` v1 message on ' +
      '`rasta.audit.trail.v1`, which audit-service records as a new record whose ' +
      '`correctionOf` names the target; the original then lists it in `correctedBy`. ' +
      '`occurredAt` must equal the target’s own instant. The target’s organization is ' +
      'taken from audit-service, never from the request. A missing target, or one at a ' +
      'different instant, answers `404` and writes nothing. `202` means accepted for ' +
      'recording, not yet readable: the record appears once audit-service has ingested it.',
  })
  submit(
    @Body(zodPipe(auditCorrectionCommandSchema)) command: AuditCorrectionCommand,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<AuditCorrectionAccepted> {
    return this.corrections.submit(command, idempotencyKey);
  }
}
