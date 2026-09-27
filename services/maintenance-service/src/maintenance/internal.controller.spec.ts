import { PATH_METADATA } from '@nestjs/common/constants';
import { ALLOW_SERVICE_KEY, REQUIRED_ROLES_KEY } from '@rasta/nest-common';
import {
  MaintenanceInternalController,
  MaintenanceTransferClearanceController,
} from './internal.controller';

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

/**
 * The lock on the transfer clearance (ADR-062). The count, the fence and the
 * tenant scoping behind it are proved against PostgreSQL in
 * `test/transfer-clearance.int-spec.ts`.
 */
describe('MaintenanceTransferClearanceController', () => {
  it('lives under /internal and admits only asset-service, on both routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MaintenanceTransferClearanceController)).toBe(
      'internal/assets',
    );
    for (const handler of [
      MaintenanceTransferClearanceController.prototype.clear,
      MaintenanceTransferClearanceController.prototype.release,
    ]) {
      expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, handler)).toEqual(['asset-service']);
      expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, handler)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(REQUIRED_ROLES_KEY, MaintenanceTransferClearanceController),
    ).toBeUndefined();
  });
});
