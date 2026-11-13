import { markRefusal } from '@rasta/config';

export function parseMeterReconcileArgs(args: readonly string[]): { organizationId: string } {
  let organizationId: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' && !dryRun) {
      dryRun = true;
      continue;
    }
    if (arg === '--organization-id' && organizationId === undefined) {
      const value = args[++i];
      if (value && /^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        organizationId = value;
        continue;
      }
    }
    // Includes apply: no code path can bypass the missing completeness proof.
    throw markRefusal(new Error('maintenance-meter-reconcile arguments refused'), 'usage');
  }
  if (!organizationId) throw markRefusal(new Error('organization-id is required'), 'usage');
  return { organizationId };
}
