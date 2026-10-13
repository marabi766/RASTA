import { isOrganizationNotFound } from './organization-directory';

describe('isOrganizationNotFound', () => {
  it('recognises only organization-service’s own not-found body about an organization (F2)', () => {
    expect(
      isOrganizationNotFound({
        code: 'NOT_FOUND',
        message: 'Organization not found',
        correlationId: 'c',
        timestamp: '2026-10-13T10:00:00.000Z',
        path: '/v1/organizations/ORG_1',
      }),
    ).toBe(true);
    // A route-level 404 goes through the same filter with the same code, but Nest's message.
    expect(
      isOrganizationNotFound({ code: 'NOT_FOUND', message: 'Cannot GET /v1/organizations/ORG_1' }),
    ).toBe(false);
    expect(isOrganizationNotFound({ code: 'NOT_FOUND', message: 'Tender not found' })).toBe(false);
    expect(isOrganizationNotFound({ code: 'FORBIDDEN', message: 'Organization not found' })).toBe(
      false,
    );
    for (const body of [null, '', '<html>404</html>', {}, []]) {
      expect(isOrganizationNotFound(body)).toBe(false);
    }
  });
});
