import { markRefusal } from '@rasta/config';

export function parseMeterFullRunStatusArgs(args: readonly string[]): { runId: string } {
  const [flag, runId] = args;
  // Exact token grammar, including the end of input (no trailing newline).
  if (
    args.length !== 2 ||
    flag !== '--run-id' ||
    !runId ||
    runId.startsWith('--') ||
    runId.length > 64 ||
    /[^A-Za-z0-9_-]/.test(runId)
  )
    throw markRefusal(new Error('maintenance-meter-full-run-status arguments refused'), 'usage');
  return { runId };
}
