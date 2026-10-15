import type { OrganizationRepository } from './organization.repository';
import { assertNoBlockingAncestor } from './organization.service';
import { assertSeedDoesNotReparent } from './seed-guard';

/** One organization of the demo seed (`prisma/seed.ts`), with its fixed identifier. */
export interface SeedOrganizationRow {
  id: string;
  name: string;
  shortName?: string;
  type:
    | 'DEHYARI'
    | 'MUNICIPALITY'
    | 'UNION'
    | 'COOPERATIVE'
    | 'COMPANY'
    | 'GOVERNMENT'
    | 'PRIVATE'
    | 'NATIONAL_ORGANIZATION';
  parentId: string | null;
  externalCode?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Writes one demo organization the way `OrganizationService.create` writes one: in one transaction
 * that takes the hierarchy lock first.
 *
 * The seed guards confine it to a disposable database, but not to a stopped service. It used to
 * commit a new ACTIVE row with no path and set the path in a second statement; a suspension of
 * the parent committing in between cascaded over `path <@ parent`, which a NULL path never
 * matches, and left the new row ACTIVE beneath a SUSPENDED parent (Codex on #286). Here the row
 * and its path commit together, under the lock every hierarchy writer takes: a suspension either
 * committed before (and is refused below) or waits and then cascades over the finished row. The
 * parent's path is the one it has now, read under that lock — not the one the seed gave it, which
 * a move may have changed since.
 *
 * An existing row keeps its parent, path and status: only its name and type converge. A path a
 * seed interrupted by the old two-statement write left NULL is set here, under the same checks
 * as a new row.
 */
export async function seedOrganization(
  repository: OrganizationRepository,
  org: SeedOrganizationRow,
): Promise<{ path: string; depth: number }> {
  return repository.transaction(async (tx) => {
    await repository.lockHierarchy(tx);

    // Re-parenting is a versioned move (`OrganizationService.move`), never a seed's rewrite.
    const existing = await tx.organization.findUnique({
      where: { id: org.id },
      select: { parentId: true, status: true },
    });
    assertSeedDoesNotReparent(org.id, existing, org.parentId);

    // Ancestors root-first and share-locked, as `create` reads them; NULL path = not yet placed.
    const chain = org.parentId
      ? await repository.lockAncestorChain(tx, org.parentId, { includeSelf: true })
      : [];
    const parent = chain.at(-1);
    if (org.parentId && parent?.id !== org.parentId) {
      throw new Error(`Parent ${org.parentId} must be seeded before ${org.id}`);
    }

    // A move (`OrganizationService.move`) owns the tree after the first write: a placed row keeps
    // its path, and a seed rewriting it would race one (round 6).
    const placed = existing ? await repository.getPath(org.id, tx) : null;
    if (placed === null && (existing?.status ?? 'ACTIVE') === 'ACTIVE') {
      assertNoBlockingAncestor(chain, 'seed an active organization');
    }

    if (existing) {
      await tx.organization.update({
        where: { id: org.id },
        data: { name: org.name, type: org.type, updatedBy: 'SEED' },
      });
    } else {
      await tx.organization.create({
        data: {
          id: org.id,
          name: org.name,
          shortName: org.shortName ?? null,
          type: org.type,
          status: 'ACTIVE',
          parentId: org.parentId,
          externalCode: org.externalCode ?? null,
          metadata: (org.metadata ?? {}) as object,
          createdBy: 'SEED',
          updatedBy: 'SEED',
        },
      });
    }

    if (placed !== null) return { path: placed, depth: placed.split('.').length - 1 };
    return repository.setPath(tx, org.id, parent?.path ?? null);
  });
}
