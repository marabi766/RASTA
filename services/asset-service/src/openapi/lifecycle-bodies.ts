import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { PLAIN_TEXT_PATTERN } from './update-asset-body';

/**
 * The request bodies of the three lifecycle commands — `POST
 * /v1/assets/{id}/activate`, `/status` and `/decommission` — as the published
 * document describes them.
 *
 * The same reason as `update-asset-body.ts`: this service builds its document
 * from decorators alone and a Zod body schema is invisible to that, so
 * `expectedVersion` was required on every request and described nowhere.
 * `document.spec.ts` holds each of these to its Zod schema — every key the
 * schema accepts is published and `required` is exactly the keys it does not
 * mark optional — so the two cannot drift without a failing test.
 */

const EXPECTED_VERSION: SchemaObject = {
  type: 'integer',
  minimum: 1,
  description:
    'The `version` of the asset the command was made against, as a read returned it. ' +
    'Required: a stale version is `409 OPTIMISTIC_LOCK_FAILED` and nothing is written — ' +
    'which is also what a command sent a second time answers, because the first one ' +
    'moved the version.',
};

export const ACTIVATE_ASSET_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: {
    expectedVersion: EXPECTED_VERSION,
    commissionedAt: { type: 'string', format: 'date-time' },
  },
};

export const CHANGE_STATUS_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'expectedVersion'],
  properties: {
    expectedVersion: EXPECTED_VERSION,
    status: { type: 'string', enum: ['ACTIVE', 'IDLE', 'OUT_OF_SERVICE'] },
    reason: { type: 'string', minLength: 3, maxLength: 500, ...PLAIN_TEXT_PATTERN },
  },
};

export const DECOMMISSION_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'expectedVersion'],
  properties: {
    expectedVersion: EXPECTED_VERSION,
    reason: { type: 'string', minLength: 10, maxLength: 1000, ...PLAIN_TEXT_PATTERN },
    decommissionedAt: { type: 'string', format: 'date-time' },
  },
};
