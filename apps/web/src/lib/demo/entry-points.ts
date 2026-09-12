/**
 * The identifiers the presentation dataset uses for its deep links.
 *
 * A separate module from `fixtures.ts` for one reason: the guided tour needs
 * these four strings to build its links, and the tour is loaded in **both**
 * modes. Importing them from the dataset would drag the entire dataset into a
 * live build, which is several kilobytes of gzip a live deployment can never
 * use — and ADR-003's 200 KiB budget has no room to spend on data that is
 * switched off.
 *
 * The ids are still the single source of truth: `fixtures.ts` imports them from
 * here rather than repeating the literals, so a link and the record it points at
 * cannot drift apart.
 */
export const FIXTURE_ENTRY_POINTS = {
  assetId: 'ast_demo_grader',
  maintenanceRequestId: 'mrq_demo_oil_change',
  productId: 'prd_demo_engine_oil',
  orderId: 'ord_demo_oil',
  auditEventId: 'aev_demo_0001',
  /**
   * The four ids below are the scenario engine's normalized references
   * (`lib/demo/scenario/`). Listed here rather than re-declared there, for
   * the same reason as the five above: a reference and the record it points
   * at must not be able to drift apart.
   */
  organizationId: 'org_demo_dehyari_alef',
  supplierOrganizationId: 'org_demo_supplier',
  offerId: 'ofr_demo_oil_a',
  walletId: 'wal_demo_1',
} as const;
