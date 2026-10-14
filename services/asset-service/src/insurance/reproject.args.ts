import { MAX_PAGE_SIZE } from './reproject.command';

/**
 * The arguments of `insurance:reproject` (#240 r10). Apart from the CLI so they
 * can be tested without a database: the CLI parses them before it reads the
 * environment or opens a connection, so a refusal here touches nothing.
 */
export interface ReprojectArgs {
  dryRun: boolean;
  organizationId?: string;
  pageSize: number;
  reissue: boolean;
}

/**
 * Parses the command line, or throws. An option that takes a value must have
 * one: present, non-empty and not itself an option. `--organization` with its
 * value missing would otherwise leave the filter unset — and re-project every
 * organization's policies.
 */
export function parseReprojectArgs(argv: readonly string[]): ReprojectArgs {
  const args: ReprojectArgs = { dryRun: false, pageSize: 200, reissue: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--organization') args.organizationId = optionValue(argv, ++i, flag);
    else if (flag === '--page-size') args.pageSize = Number(optionValue(argv, ++i, flag));
    else if (flag === '--reissue') args.reissue = true;
    else throw new Error(`unknown argument ${String(flag)}`);
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return args;
}

/** The value after an option: present, non-empty and not another option. */
function optionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.trim().length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}
