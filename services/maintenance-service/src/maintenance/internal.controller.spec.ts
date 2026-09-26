import { PATH_METADATA } from '@nestjs/common/constants';
import { ALLOW_SERVICE_KEY, REQUIRED_ROLES_KEY } from '@rasta/nest-common';
import { MaintenanceInternalController } from './internal.controller';

/**
 * The lock on the fact economic-service settles behind (ADR-061 § 4). The
 * behaviour behind it, tenant scoping included, is proved against PostgreSQL
 * in `test/source-fact.int-spec.ts`.
 */
describe('MaintenanceInternalController', () => {
  it('lives under /internal, which the gateway routes nowhere, and admits only economic-service', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MaintenanceInternalController)).toBe(
      'internal/maintenance-requests',
    );
    const handler = MaintenanceInternalController.prototype.get;
    expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, handler)).toEqual(['economic-service']);
    // No role grants it: the service decides, and refuses every user.
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, MaintenanceInternalController)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, handler)).toBeUndefined();
  });
});
