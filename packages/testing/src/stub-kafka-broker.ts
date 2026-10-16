import { createServer, type Server, type Socket } from 'node:net';

/**
 * A Kafka broker on loopback that answers just enough for a real kafkajs
 * idempotent producer to connect and send — and then does not answer the
 * requests a test chooses to hold (D-052 phase 4b).
 *
 * What it is for: kafkajs's `disconnect()` waits for every request in flight
 * on a connection (`RequestQueue.waitForPendingRequests`). A request this
 * broker holds is a request in flight that does not end, so a close can be
 * driven through the real client, socket and request queue rather than a fake
 * of them. Nothing here is a Kafka implementation: one node, every topic has
 * one partition led by it, and no record is stored.
 *
 * Wire format (kafkajs 2.2.4, request header v1, no tagged fields): it
 * advertises ApiVersions 0–2, Metadata 0–1, InitProducerId 0 and Produce 0–3,
 * so the client speaks Metadata v1 (which carries the controller an idempotent
 * producer asks for its id) and Produce v3 (record batches). Node 0 is this
 * broker at the same host string and port as the seed, so the client keeps
 * one connection.
 *
 * Held requests:
 *   - Produce, always: the send never returns until `release()`, which then
 *     acknowledges it.
 *   - ApiVersions, with `holdConnect`: the producer's `connect()` never returns
 *     either. `release()` answers it with INVALID_REQUEST (42), which kafkajs
 *     does not retry, so the connect fails once and leaves no retry timers.
 */
export interface StubKafkaBrokerOptions {
  /** Hold every ApiVersions request: a producer stays mid-`connect()`. */
  holdConnect?: boolean;
  /**
   * Listen on this port rather than a free one: a broker that comes up where a
   * client has been retrying (see {@link reserveFreePort}).
   */
  port?: number;
}

/** A loopback port free now, and closed again: nothing answers on it until a broker starts there. */
export async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

type HeldApi = 'ApiVersions' | 'Produce';

interface Held {
  api: HeldApi;
  socket: Socket;
  correlationId: number;
  apiVersion: number;
  /** Produce only: the topic and partitions to acknowledge. */
  topics: { topic: string; partitions: number[] }[];
}

const API = { Produce: 0, Metadata: 3, ApiVersions: 18, InitProducerId: 22 } as const;
const ADVERTISED: readonly [number, number, number][] = [
  [API.Produce, 0, 3],
  [API.Metadata, 0, 1],
  [API.ApiVersions, 0, 2],
  [API.InitProducerId, 0, 0],
];
const INVALID_REQUEST = 42;

export class StubKafkaBroker {
  readonly host = '127.0.0.1';
  private readonly sockets = new Set<Socket>();
  private readonly heldRequests: Held[] = [];
  private readonly waiters = new Set<() => void>();
  private releasing = false;
  private accepted = 0;

  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly options: StubKafkaBrokerOptions,
  ) {}

  static async start(options: StubKafkaBrokerOptions = {}): Promise<StubKafkaBroker> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');
    const broker = new StubKafkaBroker(server, address.port, options);
    server.on('connection', (socket: Socket) => broker.accept(socket));
    return broker;
  }

  /** `KAFKA_BROKERS` for a client of this broker. */
  get brokers(): string {
    return `${this.host}:${this.port}`;
  }

  /** How many client connections this broker has accepted, ever. */
  get connectionsAccepted(): number {
    return this.accepted;
  }

  /** How many client connections are open right now. */
  get openConnections(): number {
    return this.sockets.size;
  }

  /** How many requests of `api` are held, unanswered, right now. */
  held(api: HeldApi): number {
    return this.heldRequests.filter((request) => request.api === api).length;
  }

  /** Resolves once at least `count` requests of `api` are held. */
  async waitForHeld(api: HeldApi, count = 1, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.held(api) < count) {
      if (Date.now() >= deadline) {
        throw new Error(
          `StubKafkaBroker: ${count} held ${api} request(s) not seen in ${timeoutMs} ms`,
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake);
          resolve();
        }, 20);
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
    }
  }

  /**
   * Answers every held request, and every later one, so the clients that were
   * waiting finish: a Produce is acknowledged, a held ApiVersions is refused
   * with INVALID_REQUEST.
   */
  release(): void {
    this.releasing = true;
    for (const request of this.heldRequests.splice(0)) this.answerHeld(request);
  }

  /** Releases, then closes every connection and the listener. */
  async stop(): Promise<void> {
    this.release();
    // One turn for the clients to read the answers and end their sockets.
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.accepted += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const size = buffered.readInt32BE(0);
        if (buffered.length < 4 + size) break;
        const frame = buffered.subarray(4, 4 + size);
        buffered = buffered.subarray(4 + size);
        this.handle(socket, frame);
      }
    });
  }

  private handle(socket: Socket, frame: Buffer): void {
    const reader = new Reader(frame);
    const apiKey = reader.int16();
    const apiVersion = reader.int16();
    const correlationId = reader.int32();
    reader.string(); // clientId

    switch (apiKey) {
      case API.ApiVersions:
        if (this.options.holdConnect) {
          this.hold({ api: 'ApiVersions', socket, correlationId, apiVersion, topics: [] });
        } else {
          this.respond(socket, correlationId, apiVersionsBody(apiVersion, 0, ADVERTISED));
        }
        return;
      case API.Metadata: {
        const count = reader.int32();
        const topics: string[] = [];
        for (let i = 0; i < count; i += 1) topics.push(reader.string() ?? '');
        this.respond(socket, correlationId, this.metadataBody(topics));
        return;
      }
      case API.InitProducerId:
        this.respond(
          socket,
          correlationId,
          new Writer().int32(0).int16(0).int64(1000n).int16(0).build(),
        );
        return;
      case API.Produce: {
        reader.string(); // transactional_id
        reader.int16(); // acks
        reader.int32(); // timeout
        const topics: Held['topics'] = [];
        const topicCount = reader.int32();
        for (let t = 0; t < topicCount; t += 1) {
          const topic = reader.string() ?? '';
          const partitions: number[] = [];
          const partitionCount = reader.int32();
          for (let p = 0; p < partitionCount; p += 1) {
            partitions.push(reader.int32());
            reader.skip(reader.int32()); // the record batch
          }
          topics.push({ topic, partitions });
        }
        this.hold({ api: 'Produce', socket, correlationId, apiVersion, topics });
        return;
      }
      default:
        // Not advertised, so a client never sends it; left unanswered.
        return;
    }
  }

  private hold(request: Held): void {
    if (this.releasing) {
      this.answerHeld(request);
      return;
    }
    this.heldRequests.push(request);
    for (const wake of [...this.waiters]) wake();
  }

  private answerHeld(request: Held): void {
    if (request.api === 'ApiVersions') {
      this.respond(
        request.socket,
        request.correlationId,
        apiVersionsBody(request.apiVersion, INVALID_REQUEST, []),
      );
      return;
    }
    const body = new Writer().int32(request.topics.length);
    for (const { topic, partitions } of request.topics) {
      body.string(topic).int32(partitions.length);
      for (const partition of partitions) body.int32(partition).int16(0).int64(0n).int64(-1n);
    }
    this.respond(request.socket, request.correlationId, body.int32(0).build());
  }

  /** Metadata v1: this node, controller 0, each topic one partition it leads. */
  private metadataBody(topics: readonly string[]): Buffer {
    const body = new Writer()
      .int32(1)
      .int32(0)
      .string(this.host)
      .int32(this.port)
      .int16(-1) // rack: null
      .int32(0) // controller_id
      .int32(topics.length);
    for (const topic of topics) {
      body
        .int16(0)
        .string(topic)
        .int8(0) // is_internal
        .int32(1)
        .int16(0)
        .int32(0) // partition 0
        .int32(0) // leader: node 0
        .int32(1)
        .int32(0) // replicas
        .int32(1)
        .int32(0); // isr
    }
    return body.build();
  }

  private respond(socket: Socket, correlationId: number, body: Buffer): void {
    if (socket.destroyed) return;
    const header = Buffer.alloc(8);
    header.writeInt32BE(4 + body.length, 0);
    header.writeInt32BE(correlationId, 4);
    socket.write(Buffer.concat([header, body]));
  }
}

/** ApiVersions v0–v2: error, [key, min, max], then (v1+) throttle. */
function apiVersionsBody(
  version: number,
  errorCode: number,
  apis: readonly (readonly [number, number, number])[],
): Buffer {
  const body = new Writer().int16(errorCode).int32(apis.length);
  for (const [key, min, max] of apis) body.int16(key).int16(min).int16(max);
  if (version >= 1) body.int32(0);
  return body.build();
}

class Writer {
  private readonly parts: Buffer[] = [];
  int8(value: number): this {
    const b = Buffer.alloc(1);
    b.writeInt8(value);
    return this.push(b);
  }
  int16(value: number): this {
    const b = Buffer.alloc(2);
    b.writeInt16BE(value);
    return this.push(b);
  }
  int32(value: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value);
    return this.push(b);
  }
  int64(value: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(value);
    return this.push(b);
  }
  string(value: string): this {
    const bytes = Buffer.from(value, 'utf8');
    return this.int16(bytes.length).push(bytes);
  }
  build(): Buffer {
    return Buffer.concat(this.parts);
  }
  private push(b: Buffer): this {
    this.parts.push(b);
    return this;
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}
  int16(): number {
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  int32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  string(): string | null {
    const length = this.int16();
    if (length < 0) return null;
    const value = this.buffer.toString('utf8', this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  skip(bytes: number): void {
    this.offset += Math.max(0, bytes);
  }
}
