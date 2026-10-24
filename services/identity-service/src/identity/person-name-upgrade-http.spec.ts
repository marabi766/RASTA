import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { UserController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * Upgrade compatibility of the person-name rule. The pattern below is quoted
 * from `origin/main` (9ecfa4a9, `identity/dto.ts` `personName`): whitespace was
 * `\s`, so a name holding a tab, a line break or a byte-order mark was created
 * and stored unchanged. The display-text work must not turn that stored value
 * into one the next unchanged PATCH refuses (the PR accepts more, never less).
 */
const OLD_PERSON_NAME = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^(?![\s\S]*\p{Bidi_Control})[\p{Script=Arabic}\p{Script=Latin}\p{Mark}\s‌'’\-.]+$/u,
    'Name contains unsupported characters',
  );

describe('a person name stored before the upgrade (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const identity = { updateUser: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: IdentityService, useValue: identity }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter(QUIET_LOGGER as never));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    identity.updateUser.mockReset().mockResolvedValue({ id: 'USR_1' });
  });

  it.each([
    ['a tab', 'علی\tرضا'],
    ['a line feed', 'علی\nرضا'],
    ['a vertical tab', 'علی\u000bرضا'],
    ['a form feed', 'علی\u000cرضا'],
    ['a byte-order mark', 'علی﻿رضا'],
    ['a line separator', 'علی رضا'],
    ['a paragraph separator', 'علی رضا'],
  ])('keeps accepting its unchanged PATCH when the name holds %s', async (_label, firstName) => {
    // Before the upgrade: the old rule created it, the service stored it as is.
    const stored = OLD_PERSON_NAME.parse(firstName);
    expect(stored).toBe(firstName);

    // After the upgrade: sending the stored value back is not a validation failure.
    const response = await request(app.getHttpServer())
      .patch('/v1/users/USR_1')
      .send({ firstName: stored });

    expect(response.status).toBe(200);
    expect(identity.updateUser).toHaveBeenCalledWith('USR_1', { firstName: stored });
  });
});
