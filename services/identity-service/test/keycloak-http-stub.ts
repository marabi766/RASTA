import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import {
  readPlatformAttributes,
  type PlatformAttributes,
} from '../src/keycloak/platform-attributes';

/**
 * Keycloak's Admin API, stubbed at the HTTP boundary (D-064).
 *
 * The real `KeycloakAdminClient` talks to this over a real socket, so what a
 * suite proves includes the client: the token request, the read before every
 * write, the body it sends (the profile-field allowlist), its deadline, and
 * how it tells a write that may have landed from one that did not. Only the
 * behaviour Keycloak 26 has for these calls is modelled (`keycloak.client.ts`,
 * measured in `test/keycloak-live/`): a `PUT` whose body carries `attributes`
 * replaces the whole attribute map, and changes only the top-level fields it
 * carries.
 *
 * Every failure a suite needs is made to happen exactly, never hoped for:
 *
 * - `down()` — connections are refused: nothing reaches Keycloak;
 * - `nextPut('refuse', 403)` — Keycloak answers 4xx: refused, not applied;
 * - `nextPut('hang')` — the request arrives and is never answered nor applied;
 * - `nextPut('apply-then-drop')` — applied, and the answer is lost;
 * - `nextPut('hold')` — arrives, is neither answered nor applied, and is
 *   applied whenever the suite says (`releaseHeld`): a write that lands after
 *   the caller gave up on it, as an aborted request may;
 * - `nextPut('redirect')` — not applied, answered `303` to `/login`, which
 *   answers `200` to whatever follows it (`redirectTargetHits`): a proxy in
 *   front of Keycloak sending the caller to a login page (task 117, F7).
 *
 * `onPut` runs when a `PUT` arrives, before it is applied — where a suite
 * looks at the database to see what had committed by the time Keycloak was
 * written.
 */

export interface StubAccount {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  requiredActions: string[];
  attributes: Record<string, string[]>;
}

/**
 * The request budget of every ordinary success path in the Keycloak suites
 * (#458 r3 F8): generous, so a slow runner never turns a request that should
 * succeed into a timeout — and a fence it opens into one left behind. A
 * sender is made late by a pause on its own clock (`SenderClock`), never by
 * real time running past this.
 */
export const SUCCESS_REQUEST_BUDGET_MS = 5_000;

/**
 * The explicit short budget of a test **about** a deadline: a request that
 * must time out (a held or hung PUT) uses a client of its own with this.
 * What else such a test sends on that client — a recovery projection its
 * late sender asks for — still gets well over the 400 ms the suites once
 * gave every request.
 */
export const DEADLINE_FIXTURE_MS = 1_500;

/**
 * A slow runner's round trip, simulated in the success controls (#458 r3 F8):
 * longer than the 400 ms the suites once gave every request — the budget
 * under which train run 40512610264 and main run 40529495529 left fences
 * behind or timed out, and #450 run 40542848722 refused a late sample — and
 * well inside {@link SUCCESS_REQUEST_BUDGET_MS}.
 */
export const SLOW_ROUND_TRIP_MS = 600;

export interface StubRequest {
  /** `Date.now()` when the request arrived. */
  at: number;
  method: string;
  /** The Keycloak user id the request names, if any. */
  userId: string | null;
  body: Record<string, unknown> | null;
}

type PutMode =
  | { kind: 'refuse'; status: number }
  | { kind: 'hang' }
  | { kind: 'apply-then-drop' }
  | { kind: 'hold' }
  | { kind: 'delay'; ms: number }
  | { kind: 'redirect' };

const USER_PATH = /^\/admin\/realms\/[^/]+\/users\/([^/?#]+)$/;
const USERS_PATH = /^\/admin\/realms\/[^/]+\/users$/;

export class KeycloakHttpStub {
  readonly accounts = new Map<string, StubAccount>();
  /** Every admin request, in arrival order. The token endpoint is not recorded. */
  readonly requests: StubRequest[] = [];
  /** Runs when a PUT arrives, before it is applied or answered. */
  onPut: ((request: StubRequest) => Promise<void>) | null = null;
  /** Every request that followed a redirect to `/login` — none, if nothing follows one. */
  readonly redirectTargetHits: Array<{ method: string; authorization: string | null }> = [];

  private server: Server;
  private port = 0;
  private readonly modes: PutMode[] = [];
  /** Per Keycloak user id: every PUT to it is refused with this status. */
  private readonly refusing = new Map<string, number>();
  private readonly held: Array<{ apply: () => void; response: ServerResponse }> = [];
  private readonly hanging: ServerResponse[] = [];

  constructor() {
    this.server = this.newServer();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Refuses every connection from now on, open ones included. */
  async down(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.server = this.newServer();
  }

  /** Accepts connections again, on the same address. */
  async up(): Promise<void> {
    await this.start();
  }

  async close(): Promise<void> {
    for (const response of [...this.hanging, ...this.held.map((h) => h.response)]) {
      response.destroy();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** How the next PUT (any user) is treated; a queue, one entry per PUT. */
  nextPut(kind: 'hang' | 'apply-then-drop' | 'hold' | 'redirect'): void;
  nextPut(kind: 'refuse', status: number): void;
  nextPut(kind: 'delay', ms: number): void;
  nextPut(kind: PutMode['kind'], value?: number): void {
    if (kind === 'refuse') this.modes.push({ kind, status: value ?? 403 });
    else if (kind === 'delay') this.modes.push({ kind, ms: value ?? 0 });
    else this.modes.push({ kind });
  }

  /** Every PUT to this account is refused with `status` until `stopRefusing`. */
  refuseFor(keycloakId: string, status = 403): void {
    this.refusing.set(keycloakId, status);
  }

  stopRefusing(keycloakId: string): void {
    this.refusing.delete(keycloakId);
  }

  /** Applies every held PUT, in arrival order, as Keycloak would once it got to them. */
  releaseHeld(): void {
    for (const held of this.held.splice(0)) {
      held.apply();
      held.response.destroy();
    }
  }

  get heldCount(): number {
    return this.held.length;
  }

  add(account: Omit<StubAccount, 'enabled' | 'requiredActions'> & Partial<StubAccount>): void {
    this.accounts.set(account.id, {
      enabled: true,
      requiredActions: [],
      ...account,
      attributes: structuredClone(account.attributes),
    });
  }

  /** The four platform attributes the account holds now, sorted. */
  platform(keycloakId: string): PlatformAttributes {
    const account = this.accounts.get(keycloakId);
    if (!account) throw new Error(`no stub account ${keycloakId}`);
    return readPlatformAttributes(account.attributes);
  }

  /** The PUTs that reached the account, in arrival order. */
  puts(keycloakId?: string): StubRequest[] {
    return this.requests.filter(
      (request) =>
        request.method === 'PUT' && (keycloakId === undefined || request.userId === keycloakId),
    );
  }

  /**
   * The real client, pointed here, with the budget the caller names: always
   * {@link SUCCESS_REQUEST_BUDGET_MS} for an ordinary path, and a short one
   * ({@link DEADLINE_FIXTURE_MS}) only for a test about a deadline (#458 r3
   * F8). No default: a short budget is never taken by accident.
   */
  client(requestTimeoutMs: number): KeycloakAdminClient {
    return new KeycloakAdminClient({
      baseUrl: this.url,
      realm: 'rasta',
      clientId: 'rasta-backend',
      clientSecret: 'stub-client-secret',
      enabled: true,
      requestTimeoutMs,
    });
  }

  /**
   * `POST /users` (a create: 201 with the new id in `Location`, 409 for a
   * username taken) and `GET /users?username=&exact=true` (a search) — what
   * provisioning and an approval's adoption ask of Keycloak.
   */
  private async handleUsers(
    request: IncomingMessage,
    response: ServerResponse,
    raw: string,
  ): Promise<void> {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    this.requests.push({ at: Date.now(), method: request.method ?? 'GET', userId: null, body });
    if (request.method === 'POST') {
      const username = String(body?.username ?? '').toLowerCase();
      if ([...this.accounts.values()].some((account) => account.username === username)) {
        response.writeHead(409).end();
        return;
      }
      const id = `kc-${Math.random().toString(36).slice(2, 12)}`;
      this.accounts.set(id, {
        id,
        username,
        email: String(body?.email ?? ''),
        firstName: String(body?.firstName ?? ''),
        lastName: String(body?.lastName ?? ''),
        enabled: body?.enabled === true,
        requiredActions: (body?.requiredActions as string[] | undefined) ?? [],
        attributes: structuredClone((body?.attributes as Record<string, string[]>) ?? {}),
      });
      response.writeHead(201, { location: `${this.url}/admin/realms/rasta/users/${id}` }).end();
      return;
    }
    const query = new URL(request.url ?? '', this.url).searchParams;
    const username = (query.get('username') ?? '').toLowerCase();
    const found = [...this.accounts.values()].filter((account) => account.username === username);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(found));
  }

  private newServer(): Server {
    return createServer((request, response) => {
      void this.handle(request, response).catch(() => response.destroy());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (path === '/login') {
      this.redirectTargetHits.push({
        method: request.method ?? 'GET',
        authorization: request.headers.authorization ?? null,
      });
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
      return;
    }
    if (path.endsWith('/protocol/openid-connect/token')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'stub-admin-token', expires_in: 300 }));
      return;
    }
    if (USERS_PATH.test(path)) {
      await this.handleUsers(request, response, raw);
      return;
    }
    const userId = USER_PATH.exec(path)?.[1] ?? null;
    const recorded: StubRequest = {
      at: Date.now(),
      method: request.method ?? 'GET',
      userId,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    this.requests.push(recorded);

    const account = userId ? this.accounts.get(userId) : undefined;
    if (!account) {
      response.writeHead(404).end();
      return;
    }
    if (recorded.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(account));
      return;
    }
    if (recorded.method !== 'PUT') {
      response.writeHead(405).end();
      return;
    }

    await this.onPut?.(recorded);
    const apply = () => applyPut(account, recorded.body ?? {});
    const refusal = this.refusing.get(account.id);
    if (refusal !== undefined) {
      response.writeHead(refusal).end();
      return;
    }
    const mode = this.modes.shift();
    switch (mode?.kind) {
      case 'refuse':
        response.writeHead(mode.status).end();
        return;
      case 'hang':
        this.hanging.push(response);
        return;
      case 'apply-then-drop':
        apply();
        response.socket?.destroy();
        return;
      case 'hold':
        this.held.push({ apply, response });
        return;
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, mode.ms));
        break;
      case 'redirect':
        response.writeHead(303, { location: `${this.url}/login` }).end();
        return;
      default:
        break;
    }
    apply();
    response.writeHead(204).end();
  }
}

/** Keycloak 26's `PUT /users/:id`: the fields the body carries, and `attributes` wholesale. */
function applyPut(account: StubAccount, body: Record<string, unknown>): void {
  for (const field of ['email', 'firstName', 'lastName', 'enabled'] as const) {
    if (field in body) (account as unknown as Record<string, unknown>)[field] = body[field];
  }
  if ('attributes' in body) {
    account.attributes = structuredClone(body.attributes as Record<string, string[]>);
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
