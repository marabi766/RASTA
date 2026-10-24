// The first thing the server-action coverage check runs, before any TypeScript module
// is imported (a static import of a `.ts` file would crash on an older Node with a
// parser error instead of this sentence).
//
// `check-server-action-coverage.mjs` imports shared TypeScript by Node's own type
// stripping, which is unflagged from Node 22.18 (22.x), 23.6 (23.x) and 24.0. Anything
// older, anything not parseable: refuse, and say why.

/** @param {string} version e.g. `process.versions.node` */
export function nodeRefusal(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  const major = match ? Number(match[1]) : NaN;
  const minor = match ? Number(match[2]) : NaN;
  const supported = major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
  if (supported) return null;
  return `server-action coverage: Node ${JSON.stringify(String(version))} cannot run this check: it needs Node 22.18 or newer (TypeScript type stripping); nothing was checked`;
}
