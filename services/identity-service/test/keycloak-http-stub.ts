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
 *   the caller gave up on it, as an aborted request may.
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
  | { kind: 'delay'; ms: number };

const USER_PATH = /^\/admin\/realms\/[^/]+\/users\/([^/?#]+)$/;

export class KeycloakHttpStub {
  readonly accounts = new Map<string, StubAccount>();
  /** Every admin request, in arrival order. The token endpoint is not recorded. */
  readonly requests: StubRequest[] = [];
  /** Runs when a PUT arrives, before it is applied or answered. */
  onPut: ((request: StubRequest) => Promise<void>) | null = null;

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
  nextPut(kind: 'hang' | 'apply-then-drop' | 'hold'): void;
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

  /** The real client, pointed here, with a short deadline so a hang costs the suite little. */
  client(requestTimeoutMs = 400): KeycloakAdminClient {
    return new KeycloakAdminClient({
      baseUrl: this.url,
      realm: 'rasta',
      clientId: 'rasta-backend',
      clientSecret: 'stub-client-secret',
      enabled: true,
      requestTimeoutMs,
    });
  }

  private newServer(): Server {
    return createServer((request, response) => {
      void this.handle(request, response).catch(() => response.destroy());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request);
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (path.endsWith('/protocol/openid-connect/token')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'stub-admin-token', expires_in: 300 }));
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
