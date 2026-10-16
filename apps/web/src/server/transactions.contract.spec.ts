/**
 * @jest-environment node
 */
import ts from 'typescript';
import { z } from 'zod';

import {
  DISPUTE_COMMAND_FIELDS,
  DISPUTE_COMMAND_ROLES,
  DISPUTE_FIELD_LIMITS,
  DISPUTE_FROM_STATES,
  DISPUTE_TARGET_STATE,
  NEVER_ROLE,
  PLATFORM_ROLES,
  TRANSACTION_READ_ROLES,
  type DisputeCommand,
} from '@/lib/transaction-dispute-fields';
import {
  collect,
  decoratorOf,
  handlerOf,
  literalsOf,
  parseSource,
  readSource,
  rolesOf,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

import { DISPUTE_COMMAND_TABLE, DISPUTE_FIELD_MAPPING, TRANSACTION_SCHEMA } from './transactions';

/**
 * What the transaction page depends on, pinned to economic-service's source —
 * the technique of `place-order.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment
 * a copy and its original disagree. The reader refuses anything it cannot read
 * literally rather than skipping it.
 */

const SERVICE = ['services', 'economic-service', 'src'] as const;
const controller = parseSource(readSource(...SERVICE, 'transaction', 'transaction.controller.ts'));
const dto = parseSource(readSource(...SERVICE, 'transaction', 'dto.ts'));
const stateMachine = parseSource(readSource(...SERVICE, 'transaction', 'state-machine.ts'));
const service = readSource(...SERVICE, 'transaction', 'transaction.service.ts');
const access = parseSource(readSource(...SERVICE, 'access', 'access.ts'));
const views = readSource(...SERVICE, 'shared', 'views.ts');
const gatewayRoutes = readSource('services', 'api-gateway', 'src', 'config', 'routes.ts');
const platformErrors = readSource('packages', 'contracts', 'src', 'common', 'errors.ts');

/** The controller method behind each command. */
const HANDLERS: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE: 'dispute',
  RESOLVE_DISPUTE: 'resolveDispute',
};

/** The DTO each command's body is checked against. */
const SCHEMAS: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE: 'disputeTransactionSchema',
  RESOLVE_DISPUTE: 'resolveDisputeSchema',
};

describe('the routes', () => {
  it('are under /v1/transactions, version 1', () => {
    const classDecorator = collect(controller, ts.isClassDeclaration)
      .flatMap((node) => ts.getDecorators(node) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === 'Controller');
    expect(squash(classDecorator?.arguments[0]?.getText())).toBe(
      "{path:'transactions',version:'1'}",
    );
    expect(decoratorOf(controller, 'get', 'Get')?.arguments[0]?.getText()).toBe("':id'");
  });

  it.each(DISPUTE_COMMAND_TABLE)('posts $command to :id/$path', ({ command, path }) => {
    expect(decoratorOf(controller, HANDLERS[command], 'Post')?.arguments[0]?.getText()).toBe(
      `':id/${path}'`,
    );
  });

  it.each(DISPUTE_COMMAND_TABLE)(
    '$command requires an Idempotency-Key and refuses the oversight role',
    ({ command }) => {
      const text = handlerOf(controller, HANDLERS[command]).getText();
      expect(text).toContain('requireIdempotencyKey(idempotencyKey)');
      expect(text).toContain('assertNotAuditor()');
    },
  );

  it('go through a gateway prefix that requires the key', () => {
    expect(squash(gatewayRoutes)).toContain(
      "{prefix:'transactions',service:'economic',requiresIdempotencyKey:true}",
    );
  });
});

describe('the roles the portal mirrors', () => {
  it('read: exactly the route’s @Roles', () => {
    expect(rolesOf(controller, 'get').sort()).toEqual([...TRANSACTION_READ_ROLES].sort());
  });

  it.each(DISPUTE_COMMAND_TABLE)('$command: exactly the route’s @Roles', ({ command }) => {
    expect(rolesOf(controller, HANDLERS[command]).sort()).toEqual(
      [...DISPUTE_COMMAND_ROLES[command]].sort(),
    );
  });

  it('platform scope: exactly PLATFORM_ROLES', () => {
    expect(literalsOf(topLevelConst(access, 'PLATFORM_ROLES').getText()).sort()).toEqual(
      [...PLATFORM_ROLES].sort(),
    );
  });

  it('the payer rule: both commands commit the payer, which only a platform role may cross', () => {
    // `move` is how dispute and resolveDispute change state; it authorizes COMMIT.
    expect(squash(service)).toContain("this.move(transactionId,'DISPUTE',");
    expect(squash(service)).toContain("this.move(transactionId,'RESOLVE_DISPUTE',");
    expect(squash(service)).toContain("this.authorizeAct(transaction,'COMMIT')");
    expect(squash(service)).toContain('canCommitOrganization(transaction.organizationId)');
    const commit = squash(
      collect(access, ts.isFunctionDeclaration)
        .find((node) => node.name?.text === 'canCommitOrganization')
        ?.getText(),
    );
    expect(commit).toContain('getOrganizationId()!==organizationId&&!hasPlatformScope()');
  });

  it('the oversight role is refused whatever else it holds', () => {
    expect(NEVER_ROLE).toBe('AUDITOR');
    expect(squash(access.getText())).toContain("context.roles.includes('AUDITOR')");
  });
});

/**
 * Optional fields economic-service accepts that the portal does not send yet. Listed exactly, so a
 * new field still fails here: `disputeId` (#318, docs/23 D-053) names the dispute a resolution
 * decides; omitting it keeps the pre-#318 behaviour.
 */
const OPTIONAL_UNSENT: Readonly<Record<DisputeCommand, Readonly<Record<string, string>>>> = {
  DISPUTE: {},
  RESOLVE_DISPUTE: { disputeId: 'disputeId:z.string().trim().min(1).max(64).optional()' },
};

describe('the bodies', () => {
  it.each(DISPUTE_COMMAND_TABLE)(
    '$command: strict, with the one field the portal sends, its limits, and only listed optional extras',
    ({ command }) => {
      const field = DISPUTE_COMMAND_FIELDS[command];
      const schema = squash(topLevelConst(dto, SCHEMAS[command]).getText()) ?? '';
      expect(schema).toContain('.strict()');
      const extras = OPTIONAL_UNSENT[command];
      expect([...schemaProperties(dto, SCHEMAS[command]).keys()]).toEqual([
        field,
        ...Object.keys(extras),
      ]);
      for (const declaration of Object.values(extras)) expect(schema).toContain(declaration);
      const { min, max } = DISPUTE_FIELD_LIMITS[field];
      expect(schema).toContain(`${field}:z.string().trim().min(${min}).max(${max})`);
    },
  );
});

describe('the state machine', () => {
  /** `TRANSITIONS` as `{ from: { event: to } }`, read literally. */
  const transitions = (() => {
    const literal = collect(
      topLevelConst(stateMachine, 'TRANSITIONS'),
      ts.isObjectLiteralExpression,
    )[0];
    if (!literal) throw new Error('`TRANSITIONS` has no object literal');
    const out = new Map<string, Map<string, string>>();
    for (const state of literal.properties) {
      if (!ts.isPropertyAssignment(state) || !ts.isObjectLiteralExpression(state.initializer)) {
        throw new Error('a TRANSITIONS entry that is not a literal');
      }
      const edges = new Map<string, string>();
      for (const edge of state.initializer.properties) {
        if (!ts.isPropertyAssignment(edge) || !ts.isStringLiteral(edge.initializer)) {
          throw new Error('a TRANSITIONS edge that is not a literal');
        }
        edges.set(edge.name.getText(), edge.initializer.text);
      }
      out.set(state.name.getText(), edges);
    }
    return out;
  })();

  it.each(DISPUTE_COMMAND_TABLE)(
    '$command is legal from exactly the states the portal offers it in, and leads to its target',
    ({ command }) => {
      const from = [...transitions.entries()]
        .filter(([, edges]) => edges.has(command))
        .map(([state]) => state);
      expect(from.sort()).toEqual([...DISPUTE_FROM_STATES[command]].sort());
      for (const state of from) {
        expect(transitions.get(state)?.get(command)).toBe(DISPUTE_TARGET_STATE[command]);
      }
    },
  );

  it('has no edge from DISPUTED to SETTLED — the screen says no automatic release', () => {
    expect(transitions.get('DISPUTED')?.has('SETTLE')).toBe(false);
    expect([...(transitions.get('DISPUTED')?.values() ?? [])]).not.toContain('SETTLED');
  });
});

describe('the answer the portal reads', () => {
  /** `TransactionView` and `TransactionDetailView`'s own fields, with whether each is `| null`. */
  const viewFields = (() => {
    const out = new Map<string, boolean>();
    for (const name of ['TransactionView', 'TransactionDetailView']) {
      const declaration = collect(dto, ts.isInterfaceDeclaration).find(
        (node) => node.name.text === name,
      );
      if (!declaration) throw new Error(`no interface ${name}`);
      for (const member of declaration.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        expect(member.questionToken).toBeUndefined();
        out.set(member.name.getText(), /\|\s*null\b/.test(member.type.getText()));
      }
    }
    return out;
  })();

  const shape = TRANSACTION_SCHEMA.shape as Record<string, z.ZodTypeAny>;

  it.each(Object.keys(shape))(
    '`%s` is always sent, so the portal requires it — nullable exactly when the service says `| null`',
    (field) => {
      expect(viewFields.has(field)).toBe(true);
      expect(shape[field]!.isOptional()).toBe(false);
      expect(shape[field]!.isNullable()).toBe(viewFields.get(field));
      // Built for every row, not on some paths only.
      expect(views).toMatch(new RegExp(`\\b${field}:`));
    },
  );

  it('resolving overwrites the dispute text — the caveat the screen prints stays true', () => {
    expect(squash(service)).toContain('disputeReason:dto.resolution');
    expect(squash(service)).toContain('disputeReason:dto.reason');
    expect(viewFields.has('disputeResolvedAt')).toBe(false);
  });
});

describe('the refusals the portal says in fixed Persian', () => {
  it('are keyed by codes the platform defines, with a fallback for every other', () => {
    for (const code of Object.keys(DISPUTE_FIELD_MAPPING.byCode ?? {})) {
      expect(platformErrors).toContain(`${code}: '${code}'`);
    }
    expect(DISPUTE_FIELD_MAPPING.fallback).toEqual(expect.any(String));
    expect(DISPUTE_FIELD_MAPPING.messages).toBeUndefined();
  });
});
