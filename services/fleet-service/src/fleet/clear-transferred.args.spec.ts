import { parseClearTransferredArgs } from './clear-transferred.args';
import { MAX_PAGE_SIZE } from './clear-transferred.command';

/**
 * #240 r10: `--organization` with no value used to become `undefined` — no
 * filter — and the command cleared every organization's machines. An option
 * that takes a value is refused without one, before the database is opened.
 */
describe('insurance:clear-transferred arguments', () => {
  it('takes the defaults with no arguments', () => {
    expect(parseClearTransferredArgs([])).toEqual({
      dryRun: false,
      includeUnknownGeneration: false,
      pageSize: 100,
    });
  });

  it('takes valid values', () => {
    expect(
      parseClearTransferredArgs([
        '--dry-run',
        '--organization',
        'ORG-DEH-0001',
        '--page-size',
        '250',
        '--include-unknown-generation',
      ]),
    ).toEqual({
      dryRun: true,
      includeUnknownGeneration: true,
      organizationId: 'ORG-DEH-0001',
      pageSize: 250,
    });
  });

  describe.each(['--organization', '--page-size'])('%s', (flag) => {
    it('is refused with its value missing at the end of the line', () => {
      expect(() => parseClearTransferredArgs(['--dry-run', flag])).toThrow(`${flag} needs a value`);
    });

    it('is refused with an empty or blank value', () => {
      expect(() => parseClearTransferredArgs([flag, ''])).toThrow(`${flag} needs a value`);
      expect(() => parseClearTransferredArgs([flag, '  '])).toThrow(`${flag} needs a value`);
    });

    it('is refused when what follows is another option, which is not taken as its value', () => {
      expect(() => parseClearTransferredArgs([flag, '--dry-run'])).toThrow(`${flag} needs a value`);
      expect(() => parseClearTransferredArgs([flag, '--include-unknown-generation'])).toThrow(
        `${flag} needs a value`,
      );
    });
  });

  it('refuses a page size out of range or not an integer', () => {
    for (const size of ['0', String(MAX_PAGE_SIZE + 1), '2.5', 'many']) {
      expect(() => parseClearTransferredArgs(['--page-size', size])).toThrow(
        `--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}`,
      );
    }
  });

  it('refuses an unknown argument by its position, without repeating it (#385 r6)', () => {
    expect(() =>
      parseClearTransferredArgs(['--dry-run', '--organisation', 'ORG-DEH-0001']),
    ).toThrow(/^unknown argument at position 2; it is not repeated$/);
  });
});
