/**
 * The development seed never moves an organization that already exists (#231 round 5).
 *
 * Re-parenting is `OrganizationService.move`: it takes the hierarchy lock, stamps a higher
 * `hierarchy_version` on the organization and its whole subtree, and publishes ORGANIZATION_MOVED
 * in the same transaction. A seed that rewrote `parent_id`, `path` and `depth` itself would change
 * who governs whom without any of that — a signature's evidence would rest on a tree that moved
 * with no version to order it by. So an existing organization whose parent differs from the seed's
 * is refused, loudly; a fresh database (or one the seed already shaped) is unaffected.
 */
export class SeedWouldReparentError extends Error {
  constructor(organizationId: string) {
    super(
      `The seed will not re-parent the existing organization ${organizationId}: re-parenting is ` +
        'a move (versioned, with its event); reset the development database or move it through the API',
    );
    this.name = 'SeedWouldReparentError';
  }
}

export function assertSeedDoesNotReparent(
  organizationId: string,
  existing: { parentId: string | null } | null,
  seededParentId: string | null,
): void {
  if (existing && existing.parentId !== seededParentId) {
    throw new SeedWouldReparentError(organizationId);
  }
}
