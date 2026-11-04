import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const localRequire = createRequire(import.meta.url);

/** Dynamic tooling loads may reach linted workspace builds/configs or generated Prisma only. */
export function loadWorkspaceModule(path) {
  const resolved = realpathSync(localRequire.resolve(path));
  const local = relative(ROOT, resolved).split(sep).join('/');
  if (
    !/^(?:packages|services)\/[\w-]+\/(?:dist\/.+\.[cm]?js|src\/generated\/prisma\/[^/]+\.js|jest\.config\.js)$/.test(
      local,
    ) ||
    local.split('/').some((part) => part === 'node_modules' || part === '..')
  )
    throw new Error('Workspace module load refused');
  return localRequire(resolved);
}
