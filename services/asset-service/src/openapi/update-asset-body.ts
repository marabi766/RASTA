import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * The request body of `PATCH /v1/assets/{id}`, as the published document
 * describes it.
 *
 * This service builds its document from decorators alone, and a Zod body schema
 * is invisible to that: the body was validated on every request and described
 * nowhere, so a generated client could not know `expectedVersion` is required
 * (PR #158 review). Written out here, and held to `updateAssetSchema` by
 * `document.spec.ts` — every key the schema accepts is published, and `required`
 * is exactly the keys it does not mark optional — so the two cannot drift
 * without a failing test.
 */
export const UPDATE_ASSET_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  description:
    'At least one field besides `expectedVersion` must be present. `null` clears an optional field.',
  properties: {
    expectedVersion: {
      type: 'integer',
      minimum: 1,
      description:
        'The `version` of the asset the edit was made against, as a read returned it. ' +
        'Required: a stale version is `409 OPTIMISTIC_LOCK_FAILED` and nothing is written.',
    },
    name: { type: 'string', minLength: 2, maxLength: 200 },
    assetTag: { type: 'string', minLength: 1, maxLength: 64, nullable: true },
    manufacturer: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
    model: { type: 'string', minLength: 1, maxLength: 120, nullable: true },
    manufactureYear: { type: 'integer', minimum: 1300, maximum: 2100, nullable: true },
    specifications: { type: 'object', additionalProperties: true },
  },
};
