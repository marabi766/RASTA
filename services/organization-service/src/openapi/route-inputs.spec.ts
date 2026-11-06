import type { INestApplication } from '@nestjs/common';
import { zodRouteInputKey, zodRouteInputProblems, zodRouteInputs } from '@rasta/nest-common';
import { buildDocumentationApp, buildOrganizationOpenApiDocument } from './document';

/**
 * Route boundary (PR #710 r1 F1): every body and query a controller validates with `zodPipe` is
 * published in the served document (`main.ts` serves `buildOrganizationOpenApiDocument`) exactly
 * as the shared converter writes that schema. The documentation module holds the `AppModule`
 * controllers (`document.spec.ts`).
 */
describe('organization-service publishes every Zod-validated body and query', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDocumentationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes each one from its schema, with no exception', () => {
    const inputs = zodRouteInputs(app);
    expect(zodRouteInputProblems(buildOrganizationOpenApiDocument(app), inputs)).toEqual([]);
    // The routes of the finding are among those checked, not passed by being absent.
    expect(inputs.map(zodRouteInputKey)).toEqual(
      expect.arrayContaining([
        'OrganizationController.create body',
        'OrganizationController.list query',
        'OrganizationController.move body',
      ]),
    );
  });
});
