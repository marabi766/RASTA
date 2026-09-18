import { HTTP_CODE_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { IDEMPOTENT_KEY, REQUIRED_ROLES_KEY } from '@rasta/nest-common';
import { AuditCorrectionController } from './audit-correction.controller';
import type { AuditCorrectionService } from './audit-correction.service';
import type { AuditCorrectionCommand } from './dto';

/**
 * The controller binds the route and delegates; nothing else (AGENTS.md A-10).
 */

const COMMAND: AuditCorrectionCommand = {
  auditEventId: '01JAUDIT0000000000000001',
  occurredAt: '2026-09-12T10:00:00.000Z',
  reason: 'reason',
  changes: [{ field: 'outcome', from: 'SUCCESS', to: 'FAILURE' }],
};

describe('AuditCorrectionController', () => {
  it('is POST /v1/audit-corrections, SYSTEM_ADMIN only, answering 202', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuditCorrectionController)).toBe('audit-corrections');
    expect(Reflect.getMetadata(VERSION_METADATA, AuditCorrectionController)).toBe('1');
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, AuditCorrectionController)).toEqual([
      'SYSTEM_ADMIN',
    ]);

    const handler = AuditCorrectionController.prototype.submit;
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(202);
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, handler)).toBe(true);
  });

  it('hands the validated command and the raw key to the service, and returns its answer', async () => {
    const accepted = {
      status: 'ACCEPTED' as const,
      eventId: '01JEVENT00000000000000C11',
      correctionOf: COMMAND.auditEventId,
      acceptedAt: '2026-09-12T11:00:00.000Z',
    };
    const submit = jest.fn(async () => accepted);
    const controller = new AuditCorrectionController({
      submit,
    } as unknown as AuditCorrectionService);

    await expect(controller.submit(COMMAND, 'key-1')).resolves.toBe(accepted);
    expect(submit).toHaveBeenCalledWith(COMMAND, 'key-1');
  });

  it('passes a missing key through for the service to refuse, rather than defaulting one', async () => {
    const submit = jest.fn(async () => undefined);
    const controller = new AuditCorrectionController({
      submit,
    } as unknown as AuditCorrectionService);

    await controller.submit(COMMAND, undefined);

    expect(submit).toHaveBeenCalledWith(COMMAND, undefined);
  });
});
