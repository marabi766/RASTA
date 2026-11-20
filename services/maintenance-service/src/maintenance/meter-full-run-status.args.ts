import { markRefusal } from '@rasta/config';

export function parseMeterFullRunStatusArgs(args: readonly string[]): { runId: string } {
  const [flag, value] = args;
  const equalsForm = args.length === 1 && flag?.startsWith('--run-id=') === true;
  const runId = equalsForm ? flag.slice('--run-id='.length) : value;
  // Exact token grammar, including the end of input (no trailing newline).
  if (
    (!equalsForm && (args.length !== 2 || flag !== '--run-id' || runId?.startsWith('--'))) ||
    !runId ||
    runId.length > 64 ||
    /[^A-Za-z0-9_-]/.test(runId)
  )
    throw markRefusal(new Error('maintenance-meter-full-run-status arguments refused'), 'usage');
  return { runId };
}
