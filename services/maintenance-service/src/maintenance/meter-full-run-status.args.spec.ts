import { refusalCode } from '@rasta/config';
import { parseMeterFullRunStatusArgs } from './meter-full-run-status.args';

describe('read-only full-run status arguments', () => {
  it.each(['a', 'RUN_007-v1', '-', '_', '-RUN', 'x'.repeat(64)])(
    'accepts exact run ID %s',
    (runId) => {
      expect(parseMeterFullRunStatusArgs(['--run-id', runId])).toEqual({ runId });
    },
  );
  it.each([
    'a',
    'RUN_007-v1',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
    '-',
    '_',
    '--RUN',
    '--',
    '--apply',
    '--activate',
    '--run-id',
    '--' + 'x'.repeat(62),
  ])('accepts the full primitive grammar through equals spelling: %s', (runId) => {
    expect(parseMeterFullRunStatusArgs([`--run-id=${runId}`])).toEqual({ runId });
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
      ...[
        '',
        'x'.repeat(65),
        '--' + 'x'.repeat(63),
        ' a',
        'a ',
        'a\n',
        'a\r',
        'a\t',
        'a.b',
        'الف',
        'a/b',
        'RUN=OTHER',
        '=RUN',
      ].map((id) => [`--run-id=${id}`]),
      ...['--RUN', '--', '--activate'].map((id) => ['--run-id', id]),
      ['--run-id=RUN', '--run-id=RUN'],
      ['--run-id=RUN', '--run-id', 'RUN'],
      ['--run-id', 'RUN', '--run-id=RUN'],
      ['--run-id=RUN', 'extra'],
      ['RUN'],
      ['--run-id', 'RUN', '--run-id', 'RUN'],
      ['--run-id', 'RUN', '--run-id', 'OTHER'],
      ...['--unknown', '--apply', '--activate', '--seal', '--resume', '--dry-run', '--help'].map(
        (flag) => ['--run-id', 'RUN', flag],
      ),
      ...[
        '--unknown',
        '--apply',
        '--activate',
        '--seal',
        '--resume',
        '--dry-run',
        '--help',
      ].flatMap((flag) => [[flag], [`--run-id=--apply`, flag]]),
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
