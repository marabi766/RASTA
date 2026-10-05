import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildContractOpenApiDocument, buildDocumentationApp, formatDocument } from './document';

/**
 * Writes the committed contract: `docs/api/contract-service.openapi.json`.
 *
 * Boots the documentation module only, so no database, broker or JWKS
 * endpoint is needed and the output is the same bytes on every machine.
 * `test/openapi.int-spec.ts` proves those bytes describe the real application.
 *
 * Run from the service directory: `pnpm openapi:generate`.
 */
async function main(): Promise<void> {
  const app = await buildDocumentationApp();
  try {
    const document = buildContractOpenApiDocument(app);
    const target = resolve(
      process.cwd(),
      '..',
      '..',
      'docs',
      'api',
      'contract-service.openapi.json',
    );
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, formatDocument(document, target), 'utf8');
    console.warn(`[contract-service] OpenAPI written to ${target}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('[contract-service] OpenAPI generation failed', error);
  process.exit(1);
});
