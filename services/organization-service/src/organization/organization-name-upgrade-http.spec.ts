import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { z } from 'zod';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * Upgrade compatibility of the organisation-name rule. The pattern below is
 * quoted from `origin/main` (9ecfa4a9, `organization/dto.ts` `displayName`):
 * whitespace was `\s`, so a name holding a tab or a line break was created and
 * stored unchanged. The unchanged PATCH of it must keep validating after the
 * display-text work (the PR accepts «،» as well, never less than before).
 */
const OLD_DISPLAY_NAME = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .regex(
    /^(?![\s\S]*\p{Bidi_Control})[\p{Script=Arabic}\p{Script=Latin}\p{Nd}\p{Mark}\s‌()«»'’\-.,/]+$/u,
    'Name contains unsupported characters',
  );

describe('an organization name stored before the upgrade (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const organizations = { update: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationController],
      providers: [{ provide: OrganizationService, useValue: organizations }],
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
    organizations.update.mockReset().mockResolvedValue({ id: 'ORG_1' });
  });

  it.each([
    ['a tab', 'شرکت\tنمونه'],
    ['a line feed', 'شرکت\nنمونه'],
    ['a vertical tab', 'شرکت\u000bنمونه'],
    ['a form feed', 'شرکت\u000cنمونه'],
    ['a byte-order mark', 'شرکت﻿نمونه'],
    ['a line separator', 'شرکت نمونه'],
    ['a paragraph separator', 'شرکت نمونه'],
  ])('keeps accepting its unchanged PATCH when the name holds %s', async (_label, name) => {
    // Before the upgrade: the old rule created it, the service stored it as is.
    const stored = OLD_DISPLAY_NAME.parse(name);
    expect(stored).toBe(name);

    // After the upgrade: sending the stored name and short name back is accepted.
    const response = await request(app.getHttpServer())
      .patch('/v1/organizations/ORG_1')
      .send({ name: stored, shortName: stored });

    expect(response.status).toBe(200);
    expect(organizations.update).toHaveBeenCalledWith('ORG_1', { name: stored, shortName: stored });
  });
});
