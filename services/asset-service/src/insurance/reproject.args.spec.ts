import { parseReprojectArgs } from './reproject.args';
import { MAX_PAGE_SIZE } from './reproject.command';

/**
 * #240 r10: `--organization` with no value used to become `undefined` — no
 * filter — and the command re-projected every organization. An option that
 * takes a value is refused without one, before the database is opened.
 */
describe('insurance:reproject arguments', () => {
  it('takes the defaults with no arguments', () => {
    expect(parseReprojectArgs([])).toEqual({ dryRun: false, pageSize: 200, reissue: false });
  });

  it('takes valid values', () => {
    expect(
      parseReprojectArgs([
        '--dry-run',
        '--organization',
        'ORG-DEH-0001',
        '--page-size',
        '50',
        '--reissue',
      ]),
    ).toEqual({ dryRun: true, organizationId: 'ORG-DEH-0001', pageSize: 50, reissue: true });
  });

  describe.each(['--organization', '--page-size'])('%s', (flag) => {
    it('is refused with its value missing at the end of the line', () => {
      expect(() => parseReprojectArgs(['--dry-run', flag])).toThrow(`${flag} needs a value`);
    });

    it('is refused with an empty or blank value', () => {
      expect(() => parseReprojectArgs([flag, ''])).toThrow(`${flag} needs a value`);
      expect(() => parseReprojectArgs([flag, '  '])).toThrow(`${flag} needs a value`);
    });

    it('is refused when what follows is another option, which is not taken as its value', () => {
      expect(() => parseReprojectArgs([flag, '--reissue'])).toThrow(`${flag} needs a value`);
      expect(() => parseReprojectArgs([flag, '--dry-run'])).toThrow(`${flag} needs a value`);
    });
  });

  it('refuses a page size out of range or not an integer', () => {
    for (const size of ['0', String(MAX_PAGE_SIZE + 1), '2.5', 'many']) {
      expect(() => parseReprojectArgs(['--page-size', size])).toThrow(
        `--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}`,
      );
    }
  });

  it('refuses an unknown argument by its position, without repeating it (#385 r6)', () => {
    expect(() => parseReprojectArgs(['--dry-run', '--organisation', 'ORG-DEH-0001'])).toThrow(
      /^unknown argument at position 2; it is not repeated$/,
    );
  });
});
