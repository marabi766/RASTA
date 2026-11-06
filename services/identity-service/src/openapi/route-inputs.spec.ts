import type { INestApplication } from '@nestjs/common';
import { zodRouteInputKey, zodRouteInputProblems, zodRouteInputs } from '@rasta/nest-common';
import { buildDocumentationApp, buildIdentityOpenApiDocument } from './document';

/**
 * Route boundary (PR #710 r1 F1): every body and query a controller validates with `zodPipe` is
 * published in the served document exactly as the shared converter writes that schema. The
 * documentation module holds the `AppModule` controllers (`document.spec.ts`).
 */
describe('identity-service publishes every Zod-validated body and query', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDocumentationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes each one from its schema, with no exception', () => {
    const inputs = zodRouteInputs(app);
    expect(zodRouteInputProblems(buildIdentityOpenApiDocument(app), inputs)).toEqual([]);
    // The routes of the finding are among those checked, not passed by being absent.
    expect(inputs.map(zodRouteInputKey)).toEqual(
      expect.arrayContaining([
        'UserController.create body',
        'UserController.addMembership body',
        'UserController.switchOrganization body',
        'RegistrationController.submit body',
      ]),
    );
  });

  it('refuses the active-organization body the runtime refuses, by its published patterns', () => {
    const document = buildIdentityOpenApiDocument(app);
    const body = document.paths['/v1/users/me/active-organization']!.post!.requestBody as {
      content: Record<
        string,
        { schema: { properties: Record<string, { anyOf: { pattern: string }[] }> } }
      >;
    };
    const field = body.content['application/json']!.schema.properties.organizationId!;
    const accepts = (value: string) =>
      field.anyOf.some((branch) => new RegExp(branch.pattern).test(value));
    expect(field.anyOf.length).toBeGreaterThan(0);
    expect(accepts('not-an-id')).toBe(false);
    expect(accepts('ORG_01JBQ0000000000000000000AB')).toBe(true);
  });
});
