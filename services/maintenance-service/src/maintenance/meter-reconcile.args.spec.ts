import { parseMeterReconcileArgs } from './meter-reconcile.args';

describe('meter reconcile arguments', () => {
  it('defaults to report only', () => {
    expect(parseMeterReconcileArgs(['--organization-id', 'ORG_A'])).toEqual({
      organizationId: 'ORG_A',
    });
    expect(parseMeterReconcileArgs(['--dry-run', '--organization-id', 'ORG_A'])).toEqual({
      organizationId: 'ORG_A',
    });
  });
  it.each(
    [
      [],
      ['--apply'],
      ['--organization-id', 'ORG_A', '--apply'],
      ['--organization-id', 'https://secret.invalid'],
      ['--organization-id'],
      ['--organization-id', 'ORG_A', '--organization-id', 'ORG_B'],
      ['--dry-run', '--dry-run'],
    ].map((args) => ({ args })),
  )('refuses unsafe or ambiguous invocation %#', ({ args }) => {
    expect(() => parseMeterReconcileArgs(args)).toThrow();
  });
});
