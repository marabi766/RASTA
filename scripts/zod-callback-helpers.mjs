import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

import ts from 'typescript';

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
  // Fixed failure sentences: only the source-pinned IRR currency may supply formatting data.
  [
    'apps/web/src/lib/format',
    'apps/web/src/lib/format/index.ts',
    ['moneyInputMessage'],
    'money-message',
  ],
  // Named currency data for those sentences, never a callable or a string-input proof.
  ['apps/web/src/lib/format', 'apps/web/src/lib/format/index.ts', ['IRR'], 'currency'],
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
  // Pure string canonicaliser: folds keyboard variants and returns `string | null`. It reads only its
  // first argument as text and the `caseFold` flag; it never converts to a number, date or money.
  // `exact`: only the bare or `.ts` spelling of an import, or the function declared in that very
  // file, carries the allowance; a sibling `.mjs`/`.tsx`/`.js` of the same stem never does. The
  // result is not a string proof (it may be null), so callers must still handle `null`.
  [
    'packages/nest-common/src/text/canonical-unique-text',
    'packages/nest-common/src/text/canonical-unique-text.ts',
    ['canonicalUniqueText'],
    'canonicalizer',
    { exact: true },
  ],
  // Pure string canonicaliser: NFKC, Arabic ي/ك/digits folded, tatweel removed, blanks collapsed and
  // trimmed. String in, string out; it never converts to a number, date or money (audit L3-10).
  [
    'services/asset-service/src/asset/identifier',
    'services/asset-service/src/asset/identifier.ts',
    ['canonicalIdentifier'],
    'string',
    { exact: true },
  ],
  // `z.string().trim().regex(...)`: a string schema that refuses bidi controls. Its output is a
  // string, so a chain through `.pipe(plainText())` keeps the string proof. It is a schema factory,
  // never a callback, and never a string value. Reached through the contracts barrel, pinned below.
  ['@rasta/contracts', 'packages/contracts/src/common/text.ts', ['plainText'], 'string-schema'],
  // The ISO adapter validates syntax/finite instants and only appends issues; it never rewrites payload.value.
  ['@rasta/contracts', 'packages/contracts/src/common/iso-datetime.ts', ['isoDateTime'], 'check'],
];
// Published-parent and reviewed fixed-message formatter versions.
const pins = {
  'packages/contracts/package.json':
    'c41dcef0f00effd6c0ab3790d31f2ac1d4f4941d4e61df358b537f3ce8269e59',
  'services/asset-service/src/asset/identifier.ts':
    '58f1d8ee057dabf0cd0eae309aece7226d87a59cbf0e7efedae501d66b9f5dcb',
  'packages/nest-common/src/text/canonical-unique-text.ts':
    '5eb97cc83fd4f3dd9a9e39c88513aa5673f22ab2d8a978cd8000d78144b89ee9',
  'apps/web/src/lib/repair-order-fields.ts':
    'b80e6b6a0fccce159661427e3c1e0dce973c93e1837ea632d7b47533a9944b13',
  'packages/contracts/src/common/iso-datetime.ts': [
    'f4b9b95a3dbf414ac4fc9e9502423dbbad23facd8fcebe25c6ed18f70a6e23e8',
    '0575a17e05a4e9808cd0948bf5aa0f14b3e1abf68782907fedab9fc3cba158de',
    // FU-181 construction identities; reviewed value-preserving helper.
    '494b7b001527a51ca94be8b1241faabb61bec293b849aac6a564a4c1bf0acf87',
  ],
  'packages/contracts/src/common/pattern-refinement.ts':
    '0ef5ec0e5383f56e34e9d7b96fb7206a9bf301ccbf1a168330a0177270e442c8',
  'packages/contracts/src/common/text.ts':
    '34eafe5378f3a41f3aaa19510f970df9d520119a90a000fd2a67b7d4b510fbe7',
  'packages/contracts/src/index.ts': [
    'b71ac3bbaddf706f5158fa47e8207b8a775511bf36ff9d7408edcc1e2d793e55',
    'baa12fdedf9e9bfbbeadd2be36f3b97acc62229af37ce9bc3ccdfea5c3e98cf9',
    '262f681400ee96f279f442b5f6d83f821596808ae5b72effa0c588e6875124c9',
    // + the transaction-text exports (FU-134, PR #806): `plainText` still re-exported from text.ts.
    'd470201ab822d732e8c10f0b6db953e4a5daacf94e47ae77afd0b75b64313822',
    // + PROCUREMENT_MAX_REPLAY_WINDOW_SECONDS (FU-156): one constant beside the project-create one.
    '833a9126faf3d7bb4082515cc895e451741fdb655591ecccf8b90782af9c8824',
    // + INVENTORY_MAX_REPLAY_WINDOW_SECONDS (FU-171), numberInputInnerSchema (FU-160, #831) and the FU-152 private pattern registry exports (#840): exact union.
    'ea1656bd023da6f0fddd9d24e1842aa628939bd610f77c5a7ad4f793e277c155',
    // FU-181 construction identities; reviewed value-preserving helper.
    '45c308b60a4588cf7dfba8496b264f4c50fac4c75d5f652868ead8b9cae6de04',
    // CI repair: the pure URL helper gains a read-only construction lookup.
    'bcf57fa29d3032b8106d41bec16165a5423d810d77780e832d03101bd936e527',
    // + MAINTENANCE_MAX_REPLAY_WINDOW_SECONDS (FU-171, #879) on top of that union: exact union.
    '0d7a692210ab8c4f739096703984e7253fa3019a63f7c99049666348f2835238',
    // CI/main synchronization: exact union of FU-181 and the maintenance replay constant.
    '83991df34a484819959e3e747235a462e0f4e4a6d5c59812dfa60821a1ae036e',
  ],
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
    '952fd53124d672d01c43152b669108fe8487849ea708ab067c8da64be98b91cf',
    '61ab1f3188c8e27fcd5fadd3b517a8ec69c5dcf8f636ff80fe3e2164dc88dd55',
    // + limits from TRANSACTION_TEXT_BOUNDS (FU-134, PR #806); `isOrderCommand` unchanged.
    'b7d5f55a96f188adb1af73dc11ad1fa628d7d1e32b5a5cf6d3f2cef508eb5c9f',
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
// Resolve the import spelling before granting a capability. Ambiguous file /
// directory or extension siblings are refused instead of guessing a toolchain's
// precedence. JS specifiers may name TS sources, as in the repository imports.
const resolvedSource = (root, modulePath) => {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
  const ext = extensions.includes(extname(modulePath)) ? extname(modulePath) : '';
  const replacements = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
  };
  const candidates = ext
    ? (replacements[ext] ?? [ext]).map((suffix) => modulePath.slice(0, -ext.length) + suffix)
    : extensions.flatMap((suffix) => [modulePath + suffix, modulePath + '/index' + suffix]);
  const found = candidates.filter((path) => {
    try {
      return lstatSync(resolve(root, path)).isFile();
    } catch {
      return false;
    }
  });
  return found.length === 1 ? found[0] : undefined;
};
// Compiler configuration is part of resolution: do not assume that @/ still
// points at apps/web/src, or that a workspace has no moduleSuffixes override.
const resolvedImport = (root, specifier, importer, configImporter = importer) => {
  const config = ts.findConfigFile(dirname(configImporter), ts.sys.fileExists);
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} };
  const parsed = config && ts.getParsedCommandLineOfConfigFile(config, {}, host);
  if (config && (!parsed || parsed.errors.length)) return undefined;
  const result = ts.resolveModuleName(
    specifier,
    importer,
    parsed?.options ?? {},
    ts.sys,
  ).resolvedModule;
  return result && relative(root, result.resolvedFileName).replaceAll('\\', '/');
};
// `binding` describes how the call site names the helper: `importer` is the absolute path of the
// importing file (an import is resolved through its compiler configuration, never by spelling),
// `spelling` the final segment of the import specifier (or of the declaring file's own path) and
// `definition` the scope definition type. An `exact` entry additionally accepts only the bare or
// `.ts` module name, and only an import or a function declaration, never a variable; omitting
// `binding` refuses it.
export function verifiedCallbackHelper(root, modulePath, name, binding = {}) {
  const { importer } = binding;
  try {
    if (
      importer &&
      modulePath === '@rasta/contracts' &&
      resolvedImport(root, modulePath, importer) !== 'packages/contracts/dist/index.d.ts'
    )
      return undefined;
    if (importer && modulePath !== '@rasta/contracts') {
      const exact = resolvedImport(root, modulePath, importer);
      if (
        /\.[cm]?[jt]sx?$/.test(modulePath) &&
        !modulePath.endsWith('.js') &&
        extname(modulePath) !== extname(exact ?? '')
      )
        return undefined;
      if (!exact || resolvedSource(root, exact) !== exact) return undefined;
      modulePath = exact;
    }
    const exact = modulePath === '@rasta/contracts' ? modulePath : resolvedSource(root, modulePath);
    const helper = helpers.find(
      ([path, file, names]) =>
        (path === '@rasta/contracts' ? path === exact : file === exact) && names.includes(name),
    );
    if (!helper) return undefined;
    if (helper[4]?.exact) {
      const base = helper[0].split('/').pop();
      if (
        ![base, `${base}.ts`].includes(binding.spelling) ||
        !['ImportBinding', 'FunctionName'].includes(binding.definition)
      )
        return undefined;
    }
    const files = [
      helper[1],
      ...(helper[1] === 'packages/contracts/src/common/iso-datetime.ts'
        ? ['packages/contracts/src/common/pattern-refinement.ts']
        : []),
      ...(helper[0] === '@rasta/contracts'
        ? ['packages/contracts/src/index.ts', 'packages/contracts/package.json']
        : []),
      ...([
        'apps/web/src/lib/format',
        'apps/web/src/server/drivers',
        'apps/web/src/server/usage',
      ].includes(helper[0])
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
    // A pinned dependency must also be the dependency the compiler selects.
    // Its source bytes alone cannot authenticate a moduleSuffixes/paths shadow.
    if (importer)
      for (const file of files) {
        const ast = ts.createSourceFile(
          file,
          readFileSync(resolve(root, file), 'utf8'),
          ts.ScriptTarget.Latest,
        );
        for (const statement of ast.statements) {
          const specifier = statement.moduleSpecifier?.text;
          if (typeof specifier !== 'string') continue;
          const logical = specifier.startsWith('.')
            ? relative(root, resolve(dirname(resolve(root, file)), specifier))
            : specifier.startsWith('@/')
              ? 'apps/web/src/' + specifier.slice(2)
              : undefined;
          const expected = files.find((path) =>
            [
              path,
              path.replace(/\.ts$/, '.js'),
              path.replace(/\.ts$/, ''),
              path.replace(/\/index\.ts$/, ''),
            ].includes(logical),
          );
          if (
            expected &&
            resolvedImport(root, specifier, resolve(root, file), importer) !== expected
          )
            return undefined;
        }
      }
    if (
      files.some(
        (path) =>
          (!path.endsWith('.json') &&
            resolvedSource(root, path.replace(/\.[cm]?[jt]sx?$/, '')) !== path) ||
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
