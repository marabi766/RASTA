#!/usr/bin/env node
// The one entry of the drill CLI (`--report`, `--cleanup-from`). It has NO static import: the
// drill itself (and the modules and dependencies it loads) is imported here, inside the guard,
// so a module that cannot be loaded (a missing dependency, a checkout without `pnpm install`)
// ends in one fixed line instead of the runtime's error with its stack and source paths. The
// output of this CLI reaches the public job log (scheduled workflow), so nothing is printed
// except fixed text. Everything the drill reports about itself is in backup-restore-drill-main.mjs.
const failed = () => {
  process.stderr.write(
    '[backup-restore-drill] the command could not run to completion (a module failed to load or an internal error occurred); details are not printed\n',
  );
  process.exit(1);
};
process.on('uncaughtException', failed);
try {
  await import('./backup-restore-drill-main.mjs');
} catch {
  failed();
}
