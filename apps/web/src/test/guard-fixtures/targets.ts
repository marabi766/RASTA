import path from 'node:path';

/**
 * The two files the guard fixtures read. `UNDECLARED` is a repository file that
 * `apps/web/turbo.json` does not name (the integration spec checks that, so the
 * fixtures cannot go stale silently); `DECLARED` is one it does.
 */
const REPO = path.resolve(__dirname, '../../../../..');
export const UNDECLARED = path.join(REPO, 'services/audit-service/src/main.ts');
export const DECLARED = path.join(REPO, 'services/asset-service/src/asset/dto.ts');
