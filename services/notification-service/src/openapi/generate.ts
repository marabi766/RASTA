import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildDocumentationApp,
  buildNotificationOpenApiDocument,
  formatDocument,
} from './document';

/**
 * Writes the committed contract: `docs/api/notification-service.openapi.json`.
 *
 * Boots the documentation module only — the controller and an inert service —
 * so no database, broker or JWKS endpoint is needed to regenerate the file,
 * and the output is the same bytes on every machine. `test/openapi.int-spec.ts`
 * is what proves those bytes describe the real application.
 *
 * Run from the service directory: `pnpm openapi:generate`.
 */
async function main(): Promise<void> {
  const app = await buildDocumentationApp();
  try {
    const document = buildNotificationOpenApiDocument(app);
    const target = resolve(
      process.cwd(),
      '..',
      '..',
      'docs',
      'api',
      'notification-service.openapi.json',
    );
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, formatDocument(document, target), 'utf8');
    console.warn(`[notification-service] OpenAPI written to ${target}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('[notification-service] OpenAPI generation failed', error);
  process.exit(1);
});
