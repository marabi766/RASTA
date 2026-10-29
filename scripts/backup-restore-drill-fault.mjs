// TEST ONLY (backup-restore-drill-cli.test.mjs): `NODE_OPTIONS=--import=<this file>` makes the
// CLI's file system fail on demand, so a real process can be shown to survive (or refuse) a
// publication failure that cannot be produced from outside. Nothing in the drill imports this.
// DRILL_FAULT is JSON; every key is optional:
//   rename:         { match, skip = 0, times = 1, afterRm = false }
//                   renameSync whose destination contains `match` fails EIO `times` times after
//                   `skip` passes (only after an rmSync of a drill directory when `afterRm`);
//   fsyncDirectory: { times = 1 }  fsyncSync of a directory descriptor fails EIO `times` times;
//   rm:             { mode: 'before' | 'after', times = 1 }
//                   rmSync of a drill directory fails EIO without removing anything (before) or
//                   after removing it (after), `times` times.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const fault = JSON.parse(process.env.DRILL_FAULT ?? '{}');
const eio = () => Object.assign(new Error('EIO: injected'), { code: 'EIO' });
const remaining = (spec, key = 'times') => {
  spec[key] = (spec[key] ?? 1) - 1;
  return spec[key] >= 0;
};
let removed = false;

if (fault.rename) {
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    const spec = fault.rename;
    if (String(to).includes(spec.match) && (!spec.afterRm || removed)) {
      if ((spec.skip ?? 0) > 0) spec.skip -= 1;
      else if (remaining(spec)) throw eio();
    }
    return original(from, to);
  };
}
if (fault.fsyncDirectory) {
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && remaining(fault.fsyncDirectory)) throw eio();
    return original(fd);
  };
}
if (fault.rm) {
  const original = fs.rmSync;
  fs.rmSync = (path, options) => {
    if (!String(path).includes('rasta-restore-drill-')) return original(path, options);
    if (fault.rm.mode === 'before' && remaining(fault.rm)) throw eio();
    original(path, options);
    removed = true;
    if (fault.rm.mode === 'after' && remaining(fault.rm)) throw eio();
    return undefined;
  };
}
syncBuiltinESMExports();
