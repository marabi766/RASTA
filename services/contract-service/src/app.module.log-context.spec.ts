import { getContext, runWithContext, type RequestContext } from '@rasta/nest-common';
import { contractLogContext } from './app.module';

const context: RequestContext = {
  requestId: 'request',
  correlationId: 'correlation',
  startedAt: 0,
  authType: 'USER',
  userId: 'USR_valid',
  organizationId: 'ORG_valid',
  organizationIds: ['ORG_valid'],
  roles: ['ORGANIZATION_ADMIN'],
};
describe('contract AppModule logging context projection', () => {
  it('retains valid UID and tenant identifiers unchanged', () => {
    runWithContext(context, () => {
      expect(contractLogContext()).toMatchObject({ userId: 'USR_valid', tenantId: 'ORG_valid' });
      expect(getContext()).toEqual(context);
    });
  });
  it.each([
    'private-sentinel\u0000tail',
    'private-sentinel\ud800tail',
    'private-sentinel\udc00tail',
  ])('omits storage-invalid UID/tenant from logs without changing verified context', (invalid) => {
    const verified = {
      ...context,
      userId: invalid,
      organizationId: invalid,
      issuer: invalid,
      subject: invalid,
    };
    runWithContext(verified, () => {
      expect(JSON.stringify(contractLogContext())).not.toContain('private-sentinel');
      expect(getContext()).toEqual(verified);
    });
  });
  it('does not project issuer or subject even when UID is valid', () => {
    runWithContext({ ...context, issuer: 'private-issuer', subject: 'private-subject' }, () => {
      expect(contractLogContext()).toMatchObject({ userId: 'USR_valid' });
      expect(JSON.stringify(contractLogContext())).not.toContain('private-');
    });
  });
});
