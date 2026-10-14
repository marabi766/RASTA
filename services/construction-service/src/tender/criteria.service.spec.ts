import { RastaError } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import type { EventPublisher } from '../events/publisher';
import type { ProjectAccess } from '../access/access';
import type { IdempotencyStore } from '../shared/idempotency';
import type { CriteriaRepository } from './criteria.repository';
import type { TenderRepository } from './tender.repository';
import { CriteriaService } from './criteria.service';

/**
 * Two versions of one template label drawing the same number (a unique
 * violation) is a `409 CONFLICT`. The label is client text, so the refusal
 * names the field and never carries the value — not in the message the client
 * sees, not in the `internalContext` the exception filter logs (S-09).
 */
describe('CriteriaService.createTemplate — a version race', () => {
  const LABEL = 'access_token=secret123';

  function service(): CriteriaService {
    const prisma = {
      transaction: async () => {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      },
    } as unknown as PrismaService;
    const access = {
      assertCanWrite: () => ({ organizationId: 'ORG_A', actor: 'USR_A' }),
    } as unknown as ProjectAccess;
    const idempotency = {
      run: (_endpoint: string, _key: unknown, _dto: unknown, _status: number, work: unknown) =>
        (work as (record: unknown) => Promise<unknown>)(async () => undefined),
    } as unknown as IdempotencyStore;
    return new CriteriaService(
      prisma,
      {} as CriteriaRepository,
      {} as TenderRepository,
      {} as EventPublisher,
      access,
      idempotency,
    );
  }

  it('is a 409 that names the field, never the label', async () => {
    const refusal = await service()
      .createTemplate({
        label: LABEL,
        criteria: [{ key: 'price', name: 'Price', weightBp: 10_000, scoring: 'LOWEST_PRICE' }],
      } as never)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RastaError);
    expect((refusal as RastaError).code).toBe('CONFLICT');
    expect((refusal as RastaError).internalContext).toEqual({ field: 'label' });
    expect(
      JSON.stringify([(refusal as RastaError).message, (refusal as RastaError).internalContext]),
    ).not.toContain('secret123');
  });
});
