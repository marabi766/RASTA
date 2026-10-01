import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { PrismaService } from '../prisma/prisma.service';
import { ENV, LOGGER, STANDING_SNAPSHOT_SOURCE } from '../tokens';
import type { ConstructionEnv } from '../config/env';
import { ContractorStandingRepository } from './contractor-standing.repository';
import { SNAPSHOT_PAGE_SIZE, type StandingSnapshotSource } from './supplier-snapshot.client';

export type BootstrapOutcome = 'ALREADY_LOADED' | 'LOADED';

/**
 * Loads the contractor-standing read model from supplier-service's snapshot before
 * any contractor is eligible (CON-002 PR 5, ADR-061 § 4).
 *
 * ## Why it exists
 *
 * The consumer group starts at the **end** of `rasta.supplier.v1`, and the log keeps
 * seven days. A contractor qualified last year is nowhere in it, and a supplier
 * suspended last month and approved for CONTRACTING again today would look eligible
 * from the one event the log still holds. Replaying cannot fix that, and neither can
 * `down.sql` and a re-apply — the same log is all there is. The source of truth is
 * supplier-service, so it is asked.
 *
 * ## How it stays correct
 *
 * - **Fail closed until done.** `standing_bootstrap.completed_at` is the marker;
 *   while it is unset every eligibility question answers `STANDING_NOT_LOADED`
 *   (`ContractorStandingRepository.eligibility`). Nothing about a contractor can be
 *   concluded from a read model that is known to be incomplete.
 * - **The consumer first.** `AppModule` starts the event consumer before this, so
 *   every event published after that point is received live and every fact before
 *   it is in the snapshot read afterwards. Pages are read at slightly different
 *   times, which is harmless because...
 * - **Snapshot and events fold the same way.** A page is applied through the same
 *   commutative, idempotent writes the consumer uses (greatest qualification
 *   instant; a suspension episode filled in by its id, each half at most once), so
 *   a live event ahead of, between or behind the page that also states it leaves
 *   the same rows. The snapshot carries closed episodes too, so an old
 *   `SUPPLIER_SUSPENDED` delivered late still meets its lift.
 * - **Resumable and shared.** Each page and its marker advance commit together; a
 *   crash resumes at the recorded cursor. Several instances may run it: a page is
 *   applied under an advisory lock and only if the marker is still where the page
 *   started, so nothing is counted twice.
 * - **It is also the rebuild path.** Re-applying the migration leaves no marker,
 *   and the next start runs this again (docs/runbooks/contractor-standing-bootstrap.md).
 */
@Injectable()
export class StandingBootstrap {
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly standing: ContractorStandingRepository,
    @Inject(STANDING_SNAPSHOT_SOURCE) private readonly source: StandingSnapshotSource,
    @Inject(ENV)
    private readonly env: Pick<ConstructionEnv, 'CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS'>,
    @Inject(LOGGER) private readonly logger: Pick<Logger, 'info' | 'warn'>,
  ) {}

  /** Starts loading in the background and keeps retrying until it has. Never throws. */
  start(): void {
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One attempt, from wherever the marker says. Throws when the snapshot cannot be read or applied. */
  async runOnce(): Promise<BootstrapOutcome> {
    const state = await this.standing.bootstrapState();
    if (state?.completedAt) return 'ALREADY_LOADED';
    await this.standing.beginBootstrap();

    let cursor = state?.cursor ?? null;
    for (;;) {
      const page = await this.source.fetchPage(cursor, SNAPSHOT_PAGE_SIZE);
      if (page.hasMore && !page.nextCursor) {
        throw new Error('The snapshot says there is more and names no cursor');
      }

      const applied = await this.prisma.transaction(async (tx) => {
        // One instance applies a page at a time, and only when the marker is where
        // that page started: another instance may already have moved it on.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('standing_bootstrap', 0))`;
        const marker = await this.standing.bootstrapState(tx);
        if (marker?.completedAt) return { done: true, next: null as string | null };
        if ((marker?.cursor ?? null) !== cursor) {
          return { done: false, next: marker?.cursor ?? null };
        }

        for (const item of page.items) {
          if (item.contractingApprovedAt) {
            await this.standing.recordQualified(
              item.organizationId,
              new Date(item.contractingApprovedAt),
              tx,
            );
          }
          for (const episode of item.suspensions) {
            const refused = await this.standing.suspend(
              item.organizationId,
              episode.suspensionId,
              new Date(episode.suspendedAt),
              tx,
            );
            const refusedLift = episode.reinstatedAt
              ? await this.standing.reinstate(
                  item.organizationId,
                  episode.suspensionId,
                  new Date(episode.reinstatedAt),
                  tx,
                )
              : undefined;
            if (refused || refusedLift) {
              // The source contradicts what is recorded; skipping it would be guessing.
              throw new Error(
                `The snapshot contradicts the recorded standing (${refused ?? refusedLift})`,
              );
            }
          }
        }

        await this.standing.recordSnapshotPage(tx, {
          cursor: page.nextCursor ?? cursor,
          loaded: page.items.length,
          snapshotAt: new Date(page.snapshotAt),
        });
        if (!page.hasMore) await this.standing.completeBootstrap(tx);
        return { done: !page.hasMore, next: page.nextCursor };
      });

      if (applied.done) break;
      cursor = applied.next;
    }

    this.logger.info('The contractor standing was loaded from supplier-service');
    return 'LOADED';
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runOnce();
        return;
      } catch (error) {
        // The code and a fixed sentence: a snapshot page is never logged.
        this.logger.warn(
          `The contractor standing could not be loaded yet (${errorCode(error)}); eligibility stays closed, retrying`,
        );
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, this.env.CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS);
          this.timer.unref?.();
        });
      }
    }
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.constructor.name : 'UNKNOWN';
}
