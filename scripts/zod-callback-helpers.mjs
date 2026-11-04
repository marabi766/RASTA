import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Named reviewed helper capabilities, never a file or method-name exemption.
// A changed/unreadable source refuses until its implementation is reviewed again.
const helpers = [
  // String-only letter/digit normalization; dependencies pinned below.
  [
    'apps/web/src/lib/format',
    'apps/web/src/lib/format/index.ts',
    ['normalizePersianText', 'toLatinDigits', 'toPersianDigits'],
    'string',
  ],
  // Validates digits and scale before exact BigInt conversion; dependencies pinned below.
  ['apps/web/src/lib/format', 'apps/web/src/lib/format/index.ts', ['parseMoneyInput'], 'bigint'],
];
// Published-parent and reviewed fixed-message formatter versions.
const pins = {
  'apps/web/src/lib/form-issues.ts':
    'a26e429c7f0992c69d794a18adb497e451fc42c276ca3620c07d040ed8da755f',
  'apps/web/src/lib/format/codepoints.ts':
    '3dd73436c5fc654ea1e837e54bb344b5f9ff38283179e6ace794ce10c55c5b29',
  'apps/web/src/lib/format/digits.ts':
    '1a218b20234c545723a69bbcdfd7ade5f79f4e39dfca3b88420c379a756bf82d',
  'apps/web/src/lib/format/index.ts': [
    '59e5cb38f8017fde1ec720e2738e46f8902d65b83492308a0df5438bb7af64f7',
    '6a466d6d90474d3138a2bf1aa682bf4f52e6ace2f70222788ff4fc501f0fa61a',
  ],
  'apps/web/src/lib/format/money.ts': [
    'a76c167fba032bba883f75d9a931a6fe60af0946c12b0bca63df1600aca74f12',
    '070fa0bc82fc252e672223265059f99e26ff34eeb0caaf5a0b82544bb44605cd',
  ],
  'apps/web/src/lib/format/text.ts':
    'df06651d9fa1d3d0c03f2543b27a97caef2a2e4e35e0b8d4b7f521e472355d9c',
};
export function verifiedCallbackHelper(root, module, name) {
  const helper = helpers.find(([path, , names]) => path === module && names.includes(name));
  if (!helper) return undefined;
  try {
    const files = [
      helper[1],
      ...(module === 'apps/web/src/lib/format'
        ? Object.keys(pins).filter((path) => path.startsWith('apps/web/src/lib/format/'))
        : []),
    ];
    // The newer money implementation delegates only its fixed error sentences.
    if (
      files.includes('apps/web/src/lib/format/money.ts') &&
      createHash('sha256')
        .update(readFileSync(resolve(root, 'apps/web/src/lib/format/money.ts')))
        .digest('hex') !== 'a76c167fba032bba883f75d9a931a6fe60af0946c12b0bca63df1600aca74f12'
    )
      files.push('apps/web/src/lib/form-issues.ts');
    if (
      files.some(
        (path) =>
          ![pins[path]].flat().includes(
            createHash('sha256')
              .update(readFileSync(resolve(root, path)))
              .digest('hex'),
          ),
      )
    )
      return undefined;
    return helper[3];
  } catch {
    return undefined;
  }
}
