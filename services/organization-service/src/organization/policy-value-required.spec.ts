import { ZodValidationPipe } from '@rasta/nest-common';
import { setPolicySchema } from './dto';

/**
 * PR #444 r2, a tightening declared in its body: a policy body without
 * `value`. zod 3 read the missing key as `undefined`, which `z.unknown()`
 * takes, so the body passed and reached the insert of a required `Json`
 * column, which refused it there. zod 4.6.7 refuses a missing key whose schema
 * is not optional, so the client gets the 400 the OpenAPI document always
 * promised (`value` is required there), in zod 3's words.
 */
describe('a policy body without value', () => {
  const body = { key: 'procurement.thresholds', description: 'Why this value' };

  it('is refused at the pipe, naming the field in zod 3’s words', () => {
    let details: unknown;
    try {
      new ZodValidationPipe(setPolicySchema).transform(body, { type: 'body' });
    } catch (error) {
      details = (error as { details?: unknown }).details;
    }
    expect(details).toEqual([{ path: 'value', message: 'Required', code: 'invalid_type' }]);
  });

  it('is taken with value null, a JSON value like any other', () => {
    expect(setPolicySchema.safeParse({ ...body, value: null }).success).toBe(true);
  });
});
