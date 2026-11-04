import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Named reviewed helper capabilities, never a file or method-name exemption.
// A changed/unreadable source refuses until its implementation is reviewed again.
const helpers = [
  // Exact immutable decimal BIGINT limit; this allowance is data, never a callable helper.
  [
    'apps/web/src/lib/repair-order-fields',
    'apps/web/src/lib/repair-order-fields.ts',
    ['MAX_AMOUNT_MINOR'],
    'money-limit',
  ],
  // Declares a validated string sentence; checks controls without converting its value.
  ['apps/web/src/lib/form-issues', 'apps/web/src/lib/form-issues.ts', ['formMessage'], 'string'],
  // String-only letter/digit normalization; dependencies pinned below.
  [
    'apps/web/src/lib/format',
    'apps/web/src/lib/format/index.ts',
    ['normalizePersianText', 'toLatinDigits', 'toPersianDigits'],
    'string',
  ],
  // Validates digits and scale before exact BigInt conversion; dependencies pinned below.
  ['apps/web/src/lib/format', 'apps/web/src/lib/format/index.ts', ['parseMoneyInput'], 'bigint'],
  // Regex checked calendar fields before constructing a bounded Tehran instant.
  ['apps/web/src/server/drivers', 'apps/web/src/server/drivers.ts', ['localDateToIso'], 'verified'],
  // Regex checked calendar/time fields before constructing a bounded Tehran instant.
  ['apps/web/src/server/usage', 'apps/web/src/server/usage.ts', ['localDateTimeToIso'], 'verified'],
  // typeof string check and finite membership predicate.
  [
    'apps/web/src/lib/order-fields',
    'apps/web/src/lib/order-fields.ts',
    ['isOrderCommand'],
    'predicate',
  ],
  // Decodes text, parses JSON and validates the cursor before date construction.
  [
    'services/audit-service/src/audit/audit.cursor',
    'services/audit-service/src/audit/audit.cursor.ts',
    ['decodeAuditCursor'],
    'predicate',
  ],
  // The ISO adapter validates syntax/finite instants and only appends issues; it never rewrites payload.value.
  ['@rasta/contracts', 'packages/contracts/src/common/iso-datetime.ts', ['isoDateTime'], 'check'],
];
// Published-parent and reviewed fixed-message formatter versions.
const pins = {
  'apps/web/src/lib/repair-order-fields.ts':
    'b80e6b6a0fccce159661427e3c1e0dce973c93e1837ea632d7b47533a9944b13',
  'packages/contracts/src/common/iso-datetime.ts':
    'f4b9b95a3dbf414ac4fc9e9502423dbbad23facd8fcebe25c6ed18f70a6e23e8',
  'packages/contracts/src/index.ts':
    '5eb74d3686113d4579135376d1626bdad64abbf2b13b291d80de3d73998f514e',
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
  'apps/web/src/lib/order-fields.ts': [
    '943ca0863d6421c7dccfd33cc212507cb4a9f9ebf3fbda566b9de0139c9631f1',
    '952fd53124d672d01c43152b669108fe8487849ea708ab067c8da64be98b91cf',
  ],
  'apps/web/src/server/drivers.ts': [
    'c404487bde658fd99190401956f83270e1473fb6a738fc9c6e9acf896ad2c740',
    '0e44956c18a8e31f6f69c10fcb742076cdc67c027fb5c9217dac3e83b3ba91fe',
  ],
  'apps/web/src/server/usage.ts': [
    'b8a133b7f373bfd7c97a41360d686aaa9058ee016aadf8be031ddb2d3d0bab69',
    '2e1fbb7d26edad993a17713065546110b01391344a20a70dee9b8baaadb5e436',
  ],
  'services/audit-service/src/audit/audit.cursor.ts':
    '61320e503117b4535f008253df76539e8ec2d29159cb9d5fdcb59e56753b814b',
};
export const CALLBACK_HELPER_SOURCES = Object.freeze(Object.keys(pins));
export function verifiedCallbackHelper(root, modulePath, name) {
  const helper = helpers.find(([path, , names]) => path === modulePath && names.includes(name));
  if (!helper) return undefined;
  try {
    const files = [
      helper[1],
      ...(modulePath === '@rasta/contracts' ? ['packages/contracts/src/index.ts'] : []),
      ...([
        'apps/web/src/lib/format',
        'apps/web/src/server/drivers',
        'apps/web/src/server/usage',
      ].includes(modulePath)
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
