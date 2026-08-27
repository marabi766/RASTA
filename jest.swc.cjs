/**
 * The SWC transform options every jest project uses.
 *
 * Passed explicitly rather than left to discovery. `@swc/jest` looks for a
 * `.swcrc` in `process.cwd()` only, and jest runs with the cwd set to the
 * package, so the repository-root `.swcrc` is never the one it reads; what
 * happens next is left to SWC's own upward search, which resolved differently
 * on a Linux runner than on the machines this was written on. There,
 * `@Injectable()` became a syntax error and every suite that touches a guard
 * failed to compile — while the identical command passed locally (D-005).
 *
 * These values mirror the root `.swcrc`, which still serves the CLI and
 * anything else that reads it. `legacyDecorator` and `decoratorMetadata` are
 * the load-bearing pair: Nest resolves constructor dependencies from
 * `design:paramtypes`, so without them dependency injection breaks silently
 * rather than loudly.
 */
module.exports = {
  jsc: {
    target: 'es2023',
    parser: {
      syntax: 'typescript',
      decorators: true,
      dynamicImport: true,
    },
    transform: {
      legacyDecorator: true,
      decoratorMetadata: true,
    },
    keepClassNames: true,
  },
  module: { type: 'commonjs' },
};
