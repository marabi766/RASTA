import { ZodValidationPipe } from '@rasta/nest-common';
import { MAX_CRITERIA, criterionSchema, issueRfqSchema } from './dto';
import { MAX_INVITEES_LIMIT } from '../config/env';

/**
 * PM addendum B (PR #444 r2), on the schema the addendum names: an RFQ whose
 * criteria or invitees are over their cap is refused for the length alone,
 * and the zod 3 wording of that refusal parses nothing more — no criterion is
 * parsed and neither refinement over the list (unique codes, weights summing
 * to 10000; one invitation per organization) runs, although these lists
 * would fail all of them. Deviation 2 (accepted): those refinements' issues
 * are not reported for an over-cap list.
 */
describe('an over-cap RFQ list is refused before its elements and refinements', () => {
  const run = jest.spyOn(criterionSchema._zod, 'run');
  afterAll(() => run.mockRestore());

  function details(body: unknown): unknown {
    try {
      new ZodValidationPipe(issueRfqSchema).transform(body, { type: 'body' });
    } catch (error) {
      return (error as { details?: unknown }).details;
    }
    throw new Error('accepted');
  }

  it('criteria: one too_big, no criterion parsed, no refinement message', () => {
    run.mockClear();
    const duplicate = { code: 'PRICE', label: 'Price', weightBp: 1, scoring: 'MANUAL_SCORE' };
    const shown = details({ criteria: Array.from({ length: MAX_CRITERIA + 1 }, () => duplicate) });
    const criteria = (shown as { path: string; code: string; message: string }[]).filter((d) =>
      d.path.startsWith('criteria'),
    );
    expect(criteria).toEqual([
      {
        path: 'criteria',
        code: 'too_big',
        message: `Array must contain at most ${MAX_CRITERIA} element(s)`,
      },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it('criteria, parsed by stock zod alone (no switch, as any other parse): no criterion parsed', () => {
    // The pipe above runs legacyParse's two passes (D-078): stock zod's, then
    // zod 3's order for the wording. Each refuses the list before its elements.
    run.mockClear();
    const duplicate = { code: 'PRICE', label: 'Price', weightBp: 1, scoring: 'MANUAL_SCORE' };
    const result = issueRfqSchema.safeParse({
      criteria: Array.from({ length: MAX_CRITERIA + 1 }, () => duplicate),
    });
    expect(result.success).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('invitees: one too_big, and the once-each refinement does not run', () => {
    const same = 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X';
    const shown = details({
      invitedSupplierOrganizationIds: Array.from({ length: MAX_INVITEES_LIMIT + 1 }, () => same),
    }) as { path: string; code: string }[];
    expect(shown.filter((d) => d.path.startsWith('invitedSupplierOrganizationIds'))).toEqual([
      expect.objectContaining({ path: 'invitedSupplierOrganizationIds', code: 'too_big' }),
    ]);
  });
});
