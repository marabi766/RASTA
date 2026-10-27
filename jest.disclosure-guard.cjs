/**
 * The setup file every Jest configuration loads (`setupFilesAfterEnv`): plain
 * `not.toContain` / `not.toMatch` over a string that carries a generated value
 * (a ULID, UUID, instant or digest) the sentinel could occur inside is
 * refused, so a disclosure check cannot pass or fail by the run's clock and ids
 * (#452). The rule and the way through, `expectNotDisclosed`, are in
 * packages/testing/src/disclosure.ts.
 *
 * Loaded from source by path, transformed by each project's own transform:
 * the packages `@rasta/testing` builds on (contracts) load it too, which they
 * could not as a dependency. scripts/disclosure-guard-wiring.test.mjs holds
 * every configuration and every project to it.
 */
module.exports = require.resolve('./packages/testing/src/disclosure-guard.ts');
