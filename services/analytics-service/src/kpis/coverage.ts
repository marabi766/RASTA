/**
 * Whether the maintenance-facts projection can vouch for the whole window `[from, to)`
 * (ADR-071 § 6, Q-154, D-082). Fail closed: every unknown is "no".
 *
 * Covered only when ALL of these hold:
 *
 *   - the consumer is enabled in this deployment (a disabled projection hears nothing);
 *   - a coverage start exists — the consumer has started successfully at least once;
 *   - `from >= coverageStart` — a window that begins before the projection was complete is
 *     partial, never AVAILABLE, even when it also holds counted facts;
 *   - `to <= readAt` — the window has ended at the database's clock for this very read; a
 *     window reaching into the future is incomplete by definition.
 *
 * Deliberately NOT the earliest completion fact: that instant says when a completion happened,
 * not when the projection began listening, so it cannot tell a quiet tenant from an unknown one.
 * It does not prove the absence of lag, dead letters or events the broker dropped after its
 * retention; those belong to consumer health (ADR-071 § 6).
 */
export interface WindowCoverageInput {
  readonly consumerEnabled: boolean;
  readonly coverageStart: Date | null;
  readonly readAt: Date;
  readonly from: Date;
  readonly to: Date;
}

export function projectionCoversWindow(input: WindowCoverageInput): boolean {
  if (!input.consumerEnabled) return false;
  if (input.coverageStart === null) return false;
  return (
    input.from.getTime() >= input.coverageStart.getTime() &&
    input.to.getTime() <= input.readAt.getTime()
  );
}
