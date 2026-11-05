import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { isCanonicalBodyPipe } from './canonical';

/**
 * The guard that closes the class (Codex PR-480 r1, R2; task 129): every
 * route that takes an `Idempotency-Key` puts its body in canonical form —
 * amounts, instants, line endings — before it is validated, hashed and
 * executed, so an equivalent retry replays rather than being refused as a key
 * reused.
 *
 * Read from Nest's own parameter metadata of every controller under `src/`,
 * found on disk: a route added later, in a new controller or an old one, is
 * checked without anyone listing it. A route with a key and a body whose body
 * pipe is not `canonicalBodyPipe` fails here.
 */

/**
 * The one route that parses its body in the handler, and why it may: its
 * legacy replay needs the raw body first. It canonicalizes with
 * `canonicalPipe` before both parses; `reward-rule-canonical.int-spec.ts`.
 */
const PARSED_IN_HANDLER = new Set(['RewardController.createRule']);

interface RouteArgument {
  index: number;
  data?: unknown;
  pipes: unknown[];
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

const SRC = join(__dirname, '..');

/** Every handler of every controller class: `Class.method` → its arguments. */
function handlers(): Map<string, RouteArgument[]> {
  const found = new Map<string, RouteArgument[]>();
  for (const file of controllerFiles(SRC)) {
    const exports = jest.requireActual<Record<string, unknown>>(file);
    for (const value of Object.values(exports)) {
      if (typeof value !== 'function') continue;
      const prototype = (value as { prototype?: object }).prototype;
      if (!prototype) continue;
      for (const method of Object.getOwnPropertyNames(prototype)) {
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, value, method) as
          Record<string, RouteArgument> | undefined;
        if (!args) continue;
        found.set(
          `${value.name}.${method}`,
          Object.entries(args).map(([type, arg]) => ({ ...arg, data: [type, arg.data] })),
        );
      }
    }
  }
  return found;
}

const isOf = (arg: RouteArgument, type: RouteParamtypes) =>
  (arg.data as [string, unknown])[0].split(':')[0] === String(type);

const idempotent = [...handlers()].filter(([, args]) =>
  args.some(
    (arg) =>
      isOf(arg, RouteParamtypes.HEADERS) &&
      (arg.data as [string, unknown])[1] === 'idempotency-key',
  ),
);

describe('every idempotent route canonicalizes its body (task 129)', () => {
  it('finds the controllers on disk, and the idempotent routes among them', () => {
    expect(controllerFiles(SRC).map((file) => relative(SRC, file))).toContain(
      join('wallet', 'wallet.controller.ts'),
    );
    // The sweep, pinned: a new idempotent route shows up here as well as
    // being checked below.
    expect(idempotent.map(([name]) => name).sort()).toEqual([
      'PaymentController.refund',
      'PaymentReconciliationController.approve',
      'PaymentReconciliationController.propose',
      'PaymentReconciliationController.reject',
      'PaymentReconciliationController.requeue',
      'RewardController.createParticipationRule',
      'RewardController.createRecognitionRule',
      'RewardController.createRule',
      'SettlementController.settle',
      'TransactionController.authorise',
      'TransactionController.cancel',
      'TransactionController.create',
      'TransactionController.dispute',
      'TransactionController.refund',
      'TransactionController.resolveDispute',
      'WalletController.topUp',
    ]);
  });

  it.each(idempotent)('%s', (name, args) => {
    const bodies = args.filter((arg) => isOf(arg, RouteParamtypes.BODY));
    expect(bodies.length).toBeLessThanOrEqual(1);
    const [body] = bodies;
    if (!body) return; // nothing sent, nothing to spell two ways (`targeted(id)`)
    if (PARSED_IN_HANDLER.has(name)) {
      expect(body.pipes).toEqual([]);
      return;
    }
    expect(body.pipes).toHaveLength(1);
    expect(isCanonicalBodyPipe(body.pipes[0])).toBe(true);
  });
});
