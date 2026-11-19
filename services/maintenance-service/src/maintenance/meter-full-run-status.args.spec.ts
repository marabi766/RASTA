import { refusalCode } from '@rasta/config';
import { parseMeterFullRunStatusArgs } from './meter-full-run-status.args';

describe('read-only full-run status arguments', () => {
  it.each(['a', 'RUN_007-v1', 'x'.repeat(64)])('accepts exact run ID %s', (runId) => {
    expect(parseMeterFullRunStatusArgs(['--run-id', runId])).toEqual({ runId });
  });
  it.each(
    [
      [],
      ['--run-id'],
      ['--run-id', ''],
      ['--run-id', 'x'.repeat(65)],
      ...[' a', 'a ', 'a\n', 'a\r', 'a\t', 'a.b', 'الف', '--apply', 'a/b'].map((id) => [
        '--run-id',
        id,
      ]),
      ['--run-id=RUN'],
      ['RUN'],
      ['--run-id', 'RUN', '--run-id', 'RUN'],
      ['--run-id', 'RUN', '--run-id', 'OTHER'],
      ...['--unknown', '--apply', '--activate', '--seal', '--resume', '--dry-run', '--help'].map(
        (flag) => ['--run-id', 'RUN', flag],
      ),
      ['--operator-id', 'USR', '--run-id', 'RUN'],
      ['--run-id', 'RUN', 'extra'],
    ].map((args) => ({ args })),
  )('refuses ambiguous, invalid or extended arguments %#', ({ args }) => {
    try {
      parseMeterFullRunStatusArgs(args);
      throw new Error('unexpected acceptance');
    } catch (error) {
      expect(refusalCode(error)).toBe('usage');
    }
  });
});
