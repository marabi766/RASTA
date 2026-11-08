import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildScopedOpenApiDocument, buildDocumentationApp, formatDocument } from './document';

/**
 * Writes the committed contract: `docs/api/organization-service.openapi.json`.
 *
 * Boots the documentation module only, so no database, broker or JWKS
 * endpoint is needed and the output is the same bytes on every machine.
 * `src/openapi/document.spec.ts` holds those bytes to the generator and the documentation
 * module to the real `AppModule` controllers, its routes and their real error answers.
 *
 * Run from the service directory: `pnpm openapi:generate`.
 */
async function main(): Promise<void> {
  const app = await buildDocumentationApp();
  try {
    const document = buildScopedOpenApiDocument(app);
    const target = resolve(
      process.cwd(),
      '..',
      '..',
      'docs',
      'api',
      'organization-service.openapi.json',
    );
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, formatDocument(document, target), 'utf8');
    console.warn(`[organization-service] OpenAPI written to ${target}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('[organization-service] OpenAPI generation failed', error);
  process.exit(1);
});
