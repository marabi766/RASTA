import { markRefusal } from '@rasta/config';

export function parseMeterReconcileArgs(args: readonly string[]): {
  organizationId: string;
  apply: boolean;
} {
  let organizationId: string | undefined;
  let mode: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--dry-run' || arg === '--apply') && mode === undefined) {
      mode = arg;
      continue;
    }
    if (arg === '--organization-id' && organizationId === undefined) {
      const value = args[++i];
      if (value && /^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        organizationId = value;
        continue;
      }
    }
    throw markRefusal(new Error('maintenance-meter-reconcile arguments refused'), 'usage');
  }
  if (!organizationId) throw markRefusal(new Error('organization-id is required'), 'usage');
  return { organizationId, apply: mode === '--apply' };
}
