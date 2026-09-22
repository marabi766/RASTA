/**
 * @jest-environment node
 */
import { isSubmissionId, newSubmissionId } from './submission';

/**
 * The submission id — the thing that makes a double-click one record.
 *
 * What is asserted here is its *shape* and its uniqueness; that a repeated id
 * produces one record is proven against a real fetch in `write.spec.ts` and
 * against the service in the browser suite, because it is a property of the
 * whole path rather than of this function.
 */
describe('submission ids', () => {
  it('mints a fresh id every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newSubmissionId()));
    expect(ids.size).toBe(200);
  });

  it('accepts what it mints', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(isSubmissionId(newSubmissionId())).toBe(true);
    }
  });

  it('fits inside what a service stores as a client reference (8..128)', () => {
    const id = newSubmissionId();
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it('refuses an id a client chose for itself', () => {
    // A caller-chosen reference could be short enough to collide on purpose,
    // which would hand somebody else's record back to them.
    expect(isSubmissionId('sub_aaa')).toBe(false);
    expect(isSubmissionId('sub_')).toBe(false);
    expect(isSubmissionId('nope')).toBe(false);
    expect(isSubmissionId(`sub_${'a'.repeat(200)}`)).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(isSubmissionId(undefined)).toBe(false);
    expect(isSubmissionId(null)).toBe(false);
    expect(isSubmissionId(42)).toBe(false);
  });

  it('refuses characters outside base64url, including a path separator', () => {
    expect(isSubmissionId('sub_aaaaaaaaaaaaaaaaaa/.')).toBe(false);
    expect(isSubmissionId('sub_aaaaaaaaaaaaaaaaaa+=')).toBe(false);
  });
});
