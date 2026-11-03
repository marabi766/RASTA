/** Explicit package ownership; discovery remains independent in the CI guard. */
export const INTEGRATION_PARTITIONS = Object.freeze({
  'Integration tests': Object.freeze([
    '@rasta/identity-service',
    '@rasta/analytics-service',
    '@rasta/api-gateway',
    '@rasta/asset-service',
    '@rasta/document-service',
    '@rasta/fleet-service',
    '@rasta/maintenance-service',
    '@rasta/notification-service',
    '@rasta/organization-service',
    '@rasta/supplier-service',
  ]),
  'Integration construction': Object.freeze(['@rasta/construction-service']),
  'Integration economic': Object.freeze(['@rasta/economic-service', '@rasta/procurement-service']),
  'Integration contract': Object.freeze([
    '@rasta/contract-service',
    '@rasta/inventory-service',
    '@rasta/marketplace-service',
    '@rasta/audit-service',
  ]),
});
