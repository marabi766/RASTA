import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { ADD_NEED_ENDPOINT } from '../src/project/need.service';
import { IdempotencyStore, targeted } from '../src/shared/idempotency';
import { bearer, orgAdmin, startApi, type ApiHarness } from './api-helpers';
import { PROJECT, asAdmin, cleanup, newOrganizationId, newUserId, outboxFor } from './helpers';

const need = { expectedProjectVersion: 1, title: 'Gravel', description: 'Base course' };
const commands = ['add', 'update', 'submit', 'withdraw'] as const;

describe('need fences through HTTP', () => {
  let api: ApiHarness;
  const organizations: string[] = [];
  const org = () => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  });
  const http = () => request(api.app.getHttpServer());
  const state = (a: string) =>
    runUnscoped('inspect refused HTTP need commands', async () => ({
      projects: await api.prisma.client.project.findMany({ where: { organizationId: a } }),
      needs: await api.prisma.client.projectNeed.findMany({ where: { organizationId: a } }),
      keys: await api.prisma.client.idempotencyKey.findMany({ where: { organizationId: a } }),
      outbox: await outboxFor(api.prisma, a),
    }));
  const send = (cmd: (typeof commands)[number], id: string, token: string, body: object) => {
    const url = `/v1/projects/${id}/needs`;
    const req =
      cmd === 'update'
        ? http().patch(`${url}/PND_NONE`)
        : http().post(cmd === 'add' ? url : `${url}/PND_NONE/${cmd}`);
    return req.set('authorization', `Bearer ${token}`).send(body);
  };

  it.each(commands)(
    '%s requires a valid project version; foreign projects remain 404 and conflicts disclose no version/key',
    async (cmd) => {
      const a = org();
      const b = org();
      const token = orgAdmin(a);
      const p = await http()
        .post('/v1/projects')
        .set('authorization', `Bearer ${token}`)
        .send(PROJECT)
        .expect(201);
      const before = await state(a);
      const body =
        cmd === 'add'
          ? need
          : {
              expectedProjectVersion: 1,
              expectedVersion: 1,
              ...(cmd === 'update'
                ? { title: 'New title' }
                : cmd === 'withdraw'
                  ? { reason: 'Scope has changed' }
                  : {}),
            };
      for (const value of [undefined, null, 0, -1, 1.5, '1', 2_147_483_648]) {
        const response = await send(cmd, p.body.id as string, token, {
          ...body,
          expectedProjectVersion: value,
        });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
        expect(await state(a)).toEqual(before);
      }
      const foreign = await send(cmd, p.body.id as string, orgAdmin(b), body);
      expect(foreign.status).toBe(404);
      expect(await state(a)).toEqual(before);
      const stale = await send(cmd, p.body.id as string, token, {
        ...body,
        expectedProjectVersion: 7,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(stale.body).not.toHaveProperty('details');
      expect(JSON.stringify(stale.body)).not.toMatch(
        /currentVersion|expectedProjectVersion|deadline|need-key/,
      );
      expect(await state(a)).toEqual(before);
    },
  );

  it('PATCH with only the two version fields fails validation', async () => {
    const a = org();
    const response = await send('update', 'PRJ_NONE', orgAdmin(a), {
      expectedProjectVersion: 1,
      expectedVersion: 1,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });

  it('parses add deadlines exactly like project creation, including beyond-retention and past refusals', async () => {
    const a = org();
    const token = orgAdmin(a);
    const p = await http()
      .post('/v1/projects')
      .set('authorization', `Bearer ${token}`)
      .send(PROJECT)
      .expect(201);
    const before = await state(a);
    const url = `/v1/projects/${p.body.id as string}/needs`;
    for (const header of ['0', '01', '+1', '1.5', '9007199254740992', '1,2']) {
      const res = await http()
        .post(url)
        .set('authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'need-key')
        .set('Idempotency-Replay-Deadline', header)
        .send(need);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await state(a)).toEqual(before);
    }
    const noKey = await http()
      .post(url)
      .set('authorization', `Bearer ${token}`)
      .set('Idempotency-Replay-Deadline', String(Date.now() + 60_000))
      .send(need);
    expect(noKey.status).toBe(400);
    expect(await state(a)).toEqual(before);
    for (const [header, status, code] of [
      [Date.now() + 25 * 3_600_000, 400, 'VALIDATION_FAILED'],
      [Date.now() - 1, 409, 'REPLAY_WINDOW_CLOSED'],
    ] as const) {
      const res = await http()
        .post(url)
        .set('authorization', `Bearer ${token}`)
        .set('Idempotency-Key', 'need-key')
        .set('Idempotency-Replay-Deadline', String(header))
        .send(need);
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
      if (status === 400)
        expect(res.body.details).toEqual([
          expect.objectContaining({
            path: 'Idempotency-Replay-Deadline',
            code: 'beyond_retention',
          }),
        ]);
      else expect(res.body).not.toHaveProperty('details');
      expect(await state(a)).toEqual(before);
    }
  });

  it('a completed legacy body replays over HTTP; a new body without the fence cannot write', async () => {
    const a = org();
    const author = newUserId();
    const token = bearer({
      sub: author,
      rastaUserId: author,
      organizationId: a,
      organizationIds: [a],
      roles: ['ORGANIZATION_ADMIN'],
    });
    const p = await http()
      .post('/v1/projects')
      .set('authorization', `Bearer ${token}`)
      .send(PROJECT)
      .expect(201);
    const url = `/v1/projects/${p.body.id as string}/needs`;
    const created = await http()
      .post(url)
      .set('authorization', `Bearer ${token}`)
      .send(need)
      .expect(201);
    const legacy = { title: need.title, description: need.description };
    const store = api.app.get(IdempotencyStore);
    await asAdmin(
      a,
      () =>
        store.run(
          ADD_NEED_ENDPOINT,
          'legacy',
          targeted(p.body.id as string, { requester: author, body: legacy }),
          201,
          async (record) => {
            await api.prisma.transaction(async (tx) => {
              await record(tx, created.body.id as string, created.body);
            });
            return created.body as unknown;
          },
        ),
      author,
    );
    const before = await state(a);
    const replay = await http()
      .post(url)
      .set('authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'legacy')
      .send(legacy)
      .expect(201);
    expect(replay.body).toEqual(created.body);
    expect(await state(a)).toEqual(before);
    await http()
      .post(url)
      .set('authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'new-key')
      .send(legacy)
      .expect(400);
    expect(await state(a)).toEqual(before);
    await http()
      .post(url)
      .set('authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'legacy')
      .send(need)
      .expect(409);
    expect(await state(a)).toEqual(before);
  });
});
