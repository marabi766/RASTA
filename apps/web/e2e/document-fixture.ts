import { randomUUID } from 'node:crypto';

import { expect, type APIRequestContext } from '@playwright/test';

/**
 * A document that really exists in document-service, for a test that needs to
 * attach one to a machine through the API.
 *
 * Since #225 round 1 asset-service asks document-service who owns a document
 * before it writes the reference (docs/06): a made-up `documentId` is a 404, as
 * it should be. This registers one the way the platform does — upload-url, the
 * bytes to the signed URL, then the registration — as the caller's own
 * organization. With `ownerAssetId` the document is registered for that machine
 * (and attaches to no other); without it, it has no owner and attaches to any
 * machine of the organization.
 *
 * Each registration costs two of the person's twenty unsafe `/v1/documents`
 * requests an hour, so a spec that needs many machines registers one owner-less
 * document and shares it (`sharedDocument`).
 */
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'idempotency-key': `e2e-${randomUUID()}`,
});

export async function registerDocument(
  request: APIRequestContext,
  token: string,
  options: { ownerAssetId?: string } = {},
): Promise<string> {
  const intent = await request.post(gatewayUrl('/v1/documents/upload-url'), {
    headers: headers(token),
    data: {
      documentClass: 'OTHER',
      contentType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
      filename: 'fixture.pdf',
    },
  });
  expect(intent.status()).toBe(201);
  const { uploadIntentId, uploadUrl } = (await intent.json()) as {
    uploadIntentId: string;
    uploadUrl: string;
  };
  const stored = await request.put(uploadUrl, {
    headers: { 'content-type': 'application/pdf' },
    data: PDF_BYTES,
  });
  expect(stored.ok()).toBe(true);
  const registered = await request.post(gatewayUrl('/v1/documents'), {
    headers: headers(token),
    data: {
      uploadIntentId,
      ...(options.ownerAssetId
        ? { ownerResourceType: 'Asset', ownerResourceId: options.ownerAssetId }
        : {}),
    },
  });
  expect(registered.status()).toBe(201);
  return ((await registered.json()) as { id: string }).id;
}

let shared: Promise<string> | undefined;

/** One owner-less document per worker, registered on first use by the first caller's organization. */
export function sharedDocument(request: APIRequestContext, token: string): Promise<string> {
  shared ??= registerDocument(request, token).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}
