import type { INestApplication } from '@nestjs/common';
import { zodRouteInputProblems, zodRouteInputs } from '@rasta/nest-common';
import { buildAssetOpenApiDocument, buildDocumentationApp } from './document';

/**
 * Temporary exception (PR #710 r1 F1): asset-service does not yet publish its Zod-validated
 * bodies and queries as the shared converter writes their schemas. Covered by the FU-078 PR
 * (branch `fix/asset-openapi-bodies-from-dto-fu078`), which rewrites these bodies from the DTOs;
 * this PR does not touch asset-service source so the two cannot conflict. Each entry fails this
 * test once its route is published from its schema, so the list cannot outlive that fix; when it
 * is empty, this file becomes the same route-boundary check as identity's and organization's.
 */
const FU_078 = 'covered by the FU-078 PR: asset-service OpenAPI bodies from DTOs';
const PENDING_FU_078: Readonly<Record<string, string>> = Object.fromEntries(
  [
    // The two routes of PR #710 r1 F1: identifiers validated, nothing published.
    'AssetController.transfer body',
    'AssetController.submitClaim body',
    // Siblings found by the same check: published by hand, or not at all, not from the schema.
    'AssetController.list query',
    'AssetController.timeline query',
    'AssetController.create body',
    'AssetController.update body',
    'AssetController.activate body',
    'AssetController.changeStatus body',
    'AssetController.decommission body',
    'AssetController.recordLocation body',
    'AssetController.attachDocument body',
    'AssetController.recordPolicy body',
    'AssetController.recordInspection body',
    'AssetController.attachClaimDocument body',
    'AssetController.reviewClaim body',
    'AssetController.decideClaim body',
    'AssetController.recordClaimSettlement body',
  ].map((key) => [key, FU_078]),
);

describe('asset-service Zod-validated bodies and queries (pending FU-078)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildDocumentationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes every other one from its schema, and each pending one is still unpublished', () => {
    const document = buildAssetOpenApiDocument(app);
    expect(zodRouteInputProblems(document, zodRouteInputs(app), PENDING_FU_078)).toEqual([]);
  });

  it('still publishes no body at all for the two routes of the finding (fails once FU-078 lands)', () => {
    const document = buildAssetOpenApiDocument(app);
    expect(document.paths['/v1/assets/{id}/transfer']!.post!.requestBody).toBeUndefined();
    expect(document.paths['/v1/assets/{id}/insurance-claims']!.post!.requestBody).toBeUndefined();
  });
});
