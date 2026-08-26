import { resolveOrganization } from './auth.guard';
import { RastaError } from '../errors/rasta-error';

/**
 * Tenant resolution is the single point at which a mistake becomes a tenant
 * escape: it decides which organization a request acts for, from a header the
 * caller controls. These tests exist to make that decision hard to change by
 * accident.
 */
describe('resolveOrganization', () => {
  const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
  const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';
  const ORG_C = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YC';

  it('falls back to the token active organization when no header is sent', () => {
    expect(resolveOrganization(undefined, ORG_A, [ORG_A, ORG_B])).toBe(ORG_A);
  });

  it('accepts the active organization when explicitly requested', () => {
    expect(resolveOrganization(ORG_A, ORG_A, [ORG_A])).toBe(ORG_A);
  });

  it('accepts another organization the user is a member of', () => {
    // Multi-membership is normal: one person may administer several dehyaris.
    expect(resolveOrganization(ORG_B, ORG_A, [ORG_A, ORG_B])).toBe(ORG_B);
  });

  it('rejects an organization the user is not a member of', () => {
    expect(() => resolveOrganization(ORG_C, ORG_A, [ORG_A, ORG_B])).toThrow(RastaError);
  });

  it('rejects with TENANT_MISMATCH, not a generic forbidden', () => {
    // A distinct code matters: a burst of these is what boundary probing looks
    // like, and the alert keys on the code.
    try {
      resolveOrganization(ORG_C, ORG_A, [ORG_A]);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe('TENANT_MISMATCH');
      expect((error as RastaError).status).toBe(403);
    }
  });

  it('never silently falls back to the active organization on mismatch', () => {
    // Ignoring the header would let a caller believe they acted for C while
    // the server acted for A. Failing loudly is the only safe behaviour.
    expect(() => resolveOrganization(ORG_C, ORG_A, [ORG_A])).toThrow();
  });

  it('rejects any organization when the token carries no memberships', () => {
    expect(() => resolveOrganization(ORG_A, undefined, [])).toThrow(RastaError);
  });

  it('returns undefined for a token with no organization and no request', () => {
    // Platform-wide operations by SYSTEM_ADMIN legitimately have no tenant.
    expect(resolveOrganization(undefined, undefined, [])).toBeUndefined();
  });

  it('does not leak the membership list in the client-facing message', () => {
    try {
      resolveOrganization(ORG_C, ORG_A, [ORG_A, ORG_B]);
    } catch (error) {
      const message = (error as RastaError).message;
      expect(message).not.toContain(ORG_A);
      expect(message).not.toContain(ORG_B);
      // It is still available server-side for the audit log.
      expect((error as RastaError).internalContext).toMatchObject({ requested: ORG_C });
    }
  });
});
