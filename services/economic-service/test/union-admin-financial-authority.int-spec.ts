import request from 'supertest';
import { Logger } from '@nestjs/common';
import { runUnscoped } from '@rasta/nest-common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  admin,
  apiTenant,
  bearer,
  startApi,
  verifyInternalToken,
  type ApiHarness,
} from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A union administrator acts financially for another organization only within
 * its union's subtree (docs/24 Q-136, the product owner's decision of
 * 2026-10-16), for each of the six commands — settlement, its authorisation,
 * opening and resolving a dispute, cancellation and refund — over the real
 * HTTP stack and database, with organization-service stood up as a server that
 * answers as its provider test proves it does
 * (`organization-service/test/construction-hierarchy-contract.int-spec.ts`) and
 * verifies the token economic-service sends.
 *
 * U is a union with B beneath it; S is another union. B pays C. For each
 * command:
 *
 *   - a `UNION_ADMIN` acting for U succeeds — books on B, request (idempotency
 *     key) on U, one record line naming actor, U, B, the authority and the
 *     hierarchy version; a replay is authorised again the same way;
 *   - a `UNION_ADMIN` acting for S: 403, nothing written;
 *   - organization-service down: 503, nothing written;
 *   - an `ORGANIZATION_ADMIN` of U (no party): refused as before, nothing asked.
 *
 * "Nothing written" is the transaction row, the idempotency key, the outbox and
 * — for a settlement — the settlement row and journal.
 */
describe('a union administrator acts financially only within its union (docs/24 Q-136, HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;
  let organizationService: Server;
  let previousUrl: string | undefined;

  const union = apiTenant('UFA-U');
  const otherUnion = apiTenant('UFA-S');
  const payer = apiTenant('UFA-B');
  const payee = apiTenant('UFA-C');

  // ---- organization-service ------------------------------------------------

  /** Parent of each organization; B is under U. */
  const parent = new Map<string, string>();
  /** The hierarchy version organization-service would answer for B. */
  let payerVersion = 5;
  let mode: 'contract' | 'down' | 'hold' = 'contract';
  let release: () => void = () => undefined;
  const asked: { scope: string; caller: string; path: string }[] = [];

  function within(scope: string, organizationId: string): boolean {
    for (let at: string | undefined = organizationId; at; at = parent.get(at)) {
      if (at === scope) return true;
    }
    return false;
  }

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mode === 'down') {
      res.writeHead(503).end();
      return;
    }
    const claims = await verifyInternalToken(
      String(req.headers['x-internal-token'] ?? ''),
      'organization-service',
    ).catch(() => null);
    if (!claims?.organizationId || claims.purpose !== 'SERVICE') {
      res.writeHead(403).end();
      return;
    }
    const path = req.url ?? '';
    asked.push({ scope: claims.organizationId, caller: claims.callerService ?? '', path });
    if (mode === 'hold') await new Promise<void>((resolve) => (release = resolve));
    const organizationId = decodeURIComponent(path.replace('/v1/organizations/', ''));
    if (!within(claims.organizationId, organizationId)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Organization not found', path }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: organizationId, hierarchyVersion: payerVersion }));
  }

  // ---- callers -------------------------------------------------------------

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asUnionAdmin = (organizationId = union) =>
    `Bearer ${admin(organizationId, ['UNION_ADMIN'], 'union')}`;
  const asOrganizationAdminOfUnion = () => `Bearer ${admin(union)}`;
  const asSystemAdmin = () => `Bearer ${admin(otherUnion, ['SYSTEM_ADMIN'], 'system')}`;
  const userIdOf = (token: string) =>
    (
      JSON.parse(
        Buffer.from(token.replace(/^Bearer test\./, ''), 'base64url').toString('utf8'),
      ) as { rastaUserId: string }
    ).rastaUserId;

  beforeAll(async () => {
    organizationService = createServer((req, res) => void answer(req, res));
    await new Promise<void>((resolve) => organizationService.listen(0, '127.0.0.1', resolve));
    previousUrl = process.env.ORGANIZATION_SERVICE_URL;
    process.env.ORGANIZATION_SERVICE_URL = `http://127.0.0.1:${(organizationService.address() as AddressInfo).port}`;

    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const w = await wallet(asPayer());
    await post(`/v1/wallets/${w.id}/top-up`, asPayer(), id('ufa-topup'), {
      amountMinor: '2000000',
    }).expect(201);
    await wallet(asPayee());
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [union, otherUnion, payer, payee]);
    await harness.close();
    organizationService.closeAllConnections();
    await new Promise((resolve) => organizationService.close(resolve));
    if (previousUrl === undefined) delete process.env.ORGANIZATION_SERVICE_URL;
    else process.env.ORGANIZATION_SERVICE_URL = previousUrl;
  });

  beforeEach(() => {
    parent.clear();
    parent.set(payer, union);
    payerVersion = 5;
    mode = 'contract';
    asked.length = 0;
  });

  async function wallet(token: string) {
    return (await request(http).get('/v1/wallets/me').set('authorization', token).expect(200))
      .body as { id: string };
  }

  function post(path: string, token: string, key: string, body?: object): request.Test {
    const call = request(http).post(path).set('authorization', token).set('idempotency-key', key);
    return body ? call.send(body) : call;
  }

  type State = 'created' | 'held' | 'authorised' | 'disputed';

  /** A B→C transaction in `state`, moved there by B itself. */
  async function transaction(state: State): Promise<string> {
    const created = await post('/v1/transactions', asPayer(), id('ufa-txn'), {
      transactionType: 'MARKETPLACE_ORDER',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '9000',
      currency: 'IRR',
      holdFunds: state !== 'created',
    }).expect(201);
    const transactionId = created.body.id as string;
    if (state === 'authorised' || state === 'disputed') {
      await post(
        `/v1/transactions/${transactionId}/authorise-settlement`,
        asPayer(),
        id('a'),
      ).expect(200);
    }
    if (state === 'disputed') {
      await post(`/v1/transactions/${transactionId}/dispute`, asPayer(), id('d'), {
        reason: 'The goods arrived damaged',
      }).expect(200);
    }
    return transactionId;
  }

  interface Command {
    name: string;
    command: string;
    from: State;
    to: string;
    status: number;
    body?: object;
  }

  const COMMANDS: Command[] = [
    { name: 'settle', command: 'SETTLE', from: 'authorised', to: 'SETTLED', status: 201 },
    {
      name: 'authorise-settlement',
      command: 'AUTHORISE_SETTLEMENT',
      from: 'held',
      to: 'PENDING_SETTLEMENT',
      status: 200,
    },
    {
      name: 'dispute',
      command: 'DISPUTE',
      from: 'authorised',
      to: 'DISPUTED',
      status: 200,
      body: { reason: 'Raised by the union for its member' },
    },
    {
      name: 'resolve-dispute',
      command: 'RESOLVE_DISPUTE',
      from: 'disputed',
      to: 'PENDING_SETTLEMENT',
      status: 200,
      body: { resolution: 'The delivery note was shown to the union' },
    },
    {
      name: 'cancel',
      command: 'CANCEL',
      from: 'created',
      to: 'CANCELLED',
      status: 200,
      body: { reason: 'Withdrawn by the union for its member' },
    },
    {
      name: 'refund',
      command: 'REFUND',
      from: 'held',
      to: 'REFUNDED',
      status: 200,
      body: { reason: 'Returned by the union to its member' },
    },
  ];

  /** The command, as its caller sends it. */
  function issue(command: Command, transactionId: string, token: string, key: string) {
    return command.name === 'settle'
      ? post('/v1/settlements', token, key, { transactionId })
      : post(`/v1/transactions/${transactionId}/${command.name}`, token, key, command.body);
  }

  const read = <T>(what: string, fn: () => Promise<T>) =>
    runUnscoped(`the suite reads ${what} across every organization`, fn);

  /** Everything a command could write, to compare before and after a refusal. */
  async function written(transactionId: string, key: string) {
    const client = harness.prisma.client;
    return read('the rows a command writes', async () => ({
      transaction: await client.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        select: { status: true, updatedAt: true },
      }),
      keys: await client.idempotencyKey.count({ where: { key } }),
      outbox: await client.outboxMessage.count({ where: { aggregateId: transactionId } }),
      settlements: await client.settlement.count({ where: { transactionId } }),
      journals: await client.journal.count({ where: { transactionId } }),
    }));
  }

  /** The record lines `recordFinancialCommand` wrote while `fn` ran. */
  async function records<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const log = jest.spyOn(Logger.prototype, 'log');
    const warn = jest.spyOn(Logger.prototype, 'warn');
    try {
      const result = await fn();
      const lines = [...log.mock.calls, ...warn.mock.calls]
        .map(([message]) => String(message))
        .filter((message) => message.startsWith('Financial command'));
      return { result, lines };
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  }

  describe.each(COMMANDS)('$name', (command) => {
    it('a UNION_ADMIN acting for U succeeds on B, its member: books on B, request on U, recorded', async () => {
      const transactionId = await transaction(command.from);
      const token = asUnionAdmin();
      const key = id(`ufa-${command.name}`);

      const { result: first, lines } = await records(() =>
        issue(command, transactionId, token, key),
      );
      expect(first.status).toBe(command.status);

      // Asked of organization-service, by economic-service, for U, about B.
      expect(asked.length).toBeGreaterThanOrEqual(1);
      for (const question of asked) {
        expect(question).toEqual({
          scope: union,
          caller: 'economic-service',
          path: `/v1/organizations/${payer}`,
        });
      }

      const transactionRow = await read('the transaction', () =>
        harness.prisma.client.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
      );
      expect(transactionRow).toMatchObject({ status: command.to, organizationId: payer });

      // The request is U's: its key, completed.
      const keys = await read('the idempotency records', () =>
        harness.prisma.client.idempotencyKey.findMany({ where: { key } }),
      );
      expect(keys).toEqual([
        expect.objectContaining({ organizationId: union, state: 'COMPLETED' }),
      ]);

      // The record: actor, acting organization, books, authority, version.
      expect(lines).toEqual([
        `Financial command ${command.command} on ${transactionId}: actor=${userIdOf(token)} ` +
          `actingOrganization=${union} booksOrganization=${payer} ` +
          'authority=UNION_SUBTREE hierarchyVersion=5',
      ]);

      if (command.name === 'settle') {
        // The books stay B's; the settlement row keeps whom it was done for.
        const [settlement] = await read('the settlement', () =>
          harness.prisma.client.settlement.findMany({ where: { transactionId } }),
        );
        expect(settlement).toMatchObject({
          organizationId: payer,
          payerOrganizationId: payer,
          settledBy: userIdOf(token),
          actingOrganizationId: union,
        });
        const journals = await read('the journals', () =>
          harness.prisma.client.journal.findMany({
            where: { transactionId, journalType: 'SETTLEMENT' },
            include: { entries: true },
          }),
        );
        expect(journals).toHaveLength(1);
        expect(journals[0]).toMatchObject({ organizationId: payer });
        expect(journals[0]!.entries.some((entry) => entry.organizationId === union)).toBe(false);
      }

      // The replay is authorised the same way as a fresh request.
      asked.length = 0;
      const replay = await issue(command, transactionId, token, key);
      expect(replay.status).toBe(command.status);
      expect(replay.body).toEqual(first.body);
      expect(asked).toHaveLength(1);

      // B moved out of U: the stored answer is refused like a fresh request.
      parent.delete(payer);
      payerVersion = 6;
      const moved = await issue(command, transactionId, token, key);
      expect(moved.status).toBe(403);
      expect(moved.body.code).toBe('FORBIDDEN');
      // An error body, not the stored answer.
      expect(moved.body).not.toHaveProperty('status');
      expect(moved.body).not.toHaveProperty('settlementId');

      // organization-service down: 503, never the stored answer.
      parent.set(payer, union);
      mode = 'down';
      const down = await issue(command, transactionId, token, key);
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');

      // Back within and reachable: the same answer, nothing done twice.
      mode = 'contract';
      const restored = await issue(command, transactionId, token, key);
      expect(restored.status).toBe(command.status);
      expect(restored.body).toEqual(first.body);
      if (command.name === 'settle') {
        expect(
          await read('the settlements', () =>
            harness.prisma.client.settlement.count({ where: { transactionId } }),
          ),
        ).toBe(1);
      }
    });

    it('a UNION_ADMIN acting for S, whose subtree does not hold B: 403, nothing written', async () => {
      const transactionId = await transaction(command.from);
      const key = id(`ufa-outside-${command.name}`);
      const before = await written(transactionId, key);

      const { result: response, lines } = await records(() =>
        issue(command, transactionId, asUnionAdmin(otherUnion), key),
      );
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        code: 'FORBIDDEN',
        message:
          "Acting financially for another organization is limited to the organizations within your union's subtree",
      });
      expect(asked.map((question) => question.scope)).toContain(otherUnion);
      expect(await written(transactionId, key)).toEqual(before);
      // Logged (S-06: durable refusal audit is a recorded follow-up for every
      // economic-service refusal).
      expect(lines).toEqual([
        `Financial command ${command.command} refused: actor=${userIdOf(asUnionAdmin(otherUnion))} ` +
          `actingOrganization=${otherUnion} booksOrganization=${payer} reason=OUTSIDE_UNION_SUBTREE`,
      ]);
    });

    it('organization-service down: 503, nothing written', async () => {
      const transactionId = await transaction(command.from);
      const key = id(`ufa-down-${command.name}`);
      const before = await written(transactionId, key);
      mode = 'down';

      const response = await issue(command, transactionId, asUnionAdmin(), key);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(await written(transactionId, key)).toEqual(before);
    });

    it('an ORGANIZATION_ADMIN of U, not a party, is still refused — nothing asked, nothing written', async () => {
      const transactionId = await transaction(command.from);
      const key = id(`ufa-orgadmin-${command.name}`);
      const before = await written(transactionId, key);

      const response = await issue(command, transactionId, asOrganizationAdminOfUnion(), key);
      // resolve-dispute is a platform role's alone: the role guard answers first.
      const expected = command.name === 'resolve-dispute' ? 403 : 404;
      expect(response.status).toBe(expected);
      expect(asked).toEqual([]);
      expect(await written(transactionId, key)).toEqual(before);
    });

    it('a SYSTEM_ADMIN acting for any organization is unchanged — nothing asked', async () => {
      const transactionId = await transaction(command.from);
      const response = await issue(
        command,
        transactionId,
        asSystemAdmin(),
        id(`ufa-system-${command.name}`),
      );
      expect(response.status).toBe(command.status);
      expect(asked).toEqual([]);
    });
  });

  /**
   * The question is asked under the transaction's row lock, in the transaction
   * that commits the command (the service's one lock order: transaction row,
   * then wallets in id order). While organization-service has not answered, a
   * second command on the same transaction waits for the lock; once the union's
   * command commits, the second is judged against the state it left.
   */
  it.each([
    { name: 'cancel', from: 'created' as const, competitor: asPayer },
    { name: 'refund', from: 'held' as const, competitor: asPayee },
  ])(
    '$name: the hierarchy is asked under the row lock — a racing command waits and then meets the new state',
    async ({ name, from, competitor }) => {
      const command = COMMANDS.find((candidate) => candidate.name === name)!;
      const transactionId = await transaction(from);
      mode = 'hold';

      const unionCall = issue(command, transactionId, asUnionAdmin(), id('ufa-race-union')).then(
        (response) => response,
      );
      // The union's request has the row lock once organization-service is asked.
      // Bounded: a command that never asks fails here rather than hanging the suite.
      for (let waited = 0; asked.length === 0 && waited < 5_000; waited += 10) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(asked).toHaveLength(1);

      let competitorDone = false;
      const competitorCall = issue(command, transactionId, competitor(), id('ufa-race-other')).then(
        (response) => {
          competitorDone = true;
          return response;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(competitorDone).toBe(false);

      release();
      const [unionResponse, competitorResponse] = await Promise.all([unionCall, competitorCall]);
      expect(unionResponse.status).toBe(200);
      expect(competitorResponse.status).toBe(409);
      expect(competitorResponse.body.code).toBe('INVALID_STATE_TRANSITION');
    },
  );

  it('the settler, demoted from SYSTEM_ADMIN to UNION_ADMIN of S, is refused the replay — and answered again once restored', async () => {
    const transactionId = await transaction('authorised');
    const key = id('ufa-demoted');
    /** One person in S — the key binds issuer and subject, not roles. */
    const samePerson = (roles: string[]) =>
      `Bearer ${bearer({
        sub: `sub-ufa-person-${otherUnion}`,
        rastaUserId: 'USR-APITEST-UFA-PERSON',
        organizationId: otherUnion,
        organizationIds: [otherUnion],
        roles,
      })}`;
    const settle = (roles: string[]) =>
      post('/v1/settlements', samePerson(roles), key, { transactionId });

    const first = await settle(['SYSTEM_ADMIN']).expect(201);
    const demoted = await settle(['UNION_ADMIN']);
    expect(demoted.status).toBe(403);
    expect(demoted.body.code).toBe('FORBIDDEN');
    const disclosed = JSON.stringify(demoted.body);
    expect(disclosed).not.toContain(first.body.settlementId as string);
    expect(disclosed).not.toContain(first.body.journalId as string);

    const restored = await settle(['SYSTEM_ADMIN']).expect(201);
    expect(restored.body).toEqual(first.body);
  });

  it('a UNION_ADMIN acting for B itself is B’s own administrator — nothing asked', async () => {
    const transactionId = await transaction('authorised');
    await post(
      '/v1/settlements',
      `Bearer ${bearer({
        sub: `sub-ufa-own-${payer}`,
        rastaUserId: 'USR-APITEST-UFA-OWN',
        organizationId: payer,
        organizationIds: [payer],
        roles: ['UNION_ADMIN'],
      })}`,
      id('ufa-own'),
      { transactionId },
    ).expect(201);
    expect(asked).toEqual([]);
  });
});
