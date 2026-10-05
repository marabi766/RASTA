/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNSUPPORTED_CHARACTERS, plainText } from '@rasta/contracts';
import ts from 'typescript';

import {
  CHANGE_STATUS_TARGETS,
  USER_TRANSITIONS,
  canActivateFrom,
  canDecommissionFrom,
  statusTargetsFrom,
} from '@/lib/asset-lifecycle-fields';
import {
  BIDI_CONTROL_CODE_POINTS,
  OTHER_INVISIBLE_CODE_POINTS,
  formField,
  probesFrom,
} from '@/test/text-rules';

import {
  ACTIVATE_FIELD_MAPPING,
  ASSET_LIFECYCLE_CONFLICT_MESSAGE,
  CHANGE_STATUS_FIELD_MAPPING,
  CHANGE_STATUS_REASON_BOUNDS,
  OPEN_WORK_CODES,
  DECOMMISSION_FIELD_MAPPING,
  DECOMMISSION_REASON_BOUNDS,
  canChangeAssetStatus,
  canDecommissionAsset,
  changeStatusFormSchema,
  decommissionFormSchema,
} from './asset-lifecycle-commands';

/**
 * What the three lifecycle commands depend on, pinned to asset-service's source
 * — the technique of `asset-commands.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment a
 * copy and its original disagree. The reader refuses anything it cannot read
 * literally rather than skipping it.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');
const ASSET = ['services', 'asset-service', 'src', 'asset'] as const;
const parse = (text: string) => ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);

function topLevelConst(source: ts.SourceFile, name: string): ts.Expression {
  const found: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (!declaration.initializer) throw new Error(`\`${name}\` has no initializer`);
        found.push(declaration.initializer);
      }
    }
  }
  if (found.length !== 1) throw new Error(`expected one \`const ${name}\`, found ${found.length}`);
  return found[0]!;
}

function collect<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (test(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

const squash = (text: string | undefined) => text?.replace(/\s+/g, '');

const dtoSource = read(...ASSET, 'dto.ts');
const dto = parse(dtoSource);
const serviceSource = read(...ASSET, 'asset.service.ts');
const controller = parse(read(...ASSET, 'asset.controller.ts'));

/** The `key: initializer` properties of the schema's own object literal. */
function schemaProperties(name: string): Map<string, string> {
  const schema = topLevelConst(dto, name);
  const literal = collect(schema, ts.isObjectLiteralExpression)[0];
  if (!literal) throw new Error(`\`${name}\` has no object literal`);
  const out = new Map<string, string>();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property))
      out.set(property.name.getText(), property.initializer.getText());
    else if (ts.isShorthandPropertyAssignment(property)) out.set(property.name.getText(), '');
  }
  return out;
}

describe('who may use the commands', () => {
  function decorators(method: string, name: string): ts.CallExpression | undefined {
    const declaration = collect(controller, ts.isMethodDeclaration).find(
      (node) => node.name.getText() === method,
    );
    if (!declaration) throw new Error(`no handler \`${method}\``);
    return (ts.getDecorators(declaration) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === name);
  }

  const EVERY_ROLE = [
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'FLEET_MANAGER',
    'PROCUREMENT_USER',
    'OPERATOR',
    'DRIVER',
    'AUDITOR',
    'CONTRACTOR',
  ];

  const HANDLERS = [
    ['activate', "':id/activate'", canChangeAssetStatus],
    ['changeStatus', "':id/status'", canChangeAssetStatus],
    ['decommission', "':id/decommission'", canDecommissionAsset],
  ] as const;

  it.each(HANDLERS)(
    'is the same set of roles for %s as the portal offers the form to',
    (handler, _path, offeredTo) => {
      const roles = decorators(handler, 'Roles');
      if (!roles) throw new Error(`\`${handler}\` has no @Roles`);
      const admitted = roles.arguments.map((argument) => {
        if (!ts.isStringLiteral(argument)) throw new Error('a role that is not a literal');
        return argument.text;
      });
      expect(admitted.length).toBeGreaterThan(0);
      const offered = EVERY_ROLE.filter((role) => offeredTo([role]));
      expect(offered.sort()).toEqual(EVERY_ROLE.filter((role) => admitted.includes(role)).sort());
    },
  );

  it.each(HANDLERS)('still serves %s at the path the portal posts to', (handler, path) => {
    const post = decorators(handler, 'Post');
    expect(post?.arguments.map((argument) => argument.getText())).toEqual([path]);
  });

  it('still mounts the controller at /v1/assets', () => {
    expect(readFileSync(join(ROOT, ...ASSET, 'asset.controller.ts'), 'utf8')).toContain(
      "@Controller({ path: 'assets', version: '1' })",
    );
  });
});

describe('the request bodies', () => {
  const VERSION = /^expectedVersion$/;

  it.each(['activateAssetSchema', 'changeStatusSchema', 'decommissionSchema'])(
    '%s requires `expectedVersion`, by the one shared definition, and is strict',
    (name) => {
      const properties = schemaProperties(name);
      // Shorthand: the field is the shared required constant, not a local
      // `.optional()` copy that a direct client could omit.
      expect(properties.get('expectedVersion')).toBe('');
      expect([...properties.keys()].some((key) => VERSION.test(key))).toBe(true);
      expect(squash(topLevelConst(dto, name).getText())).toMatch(/\.strict\(\)$/);
    },
  );

  it('keeps the shared version required: an integer of at least 1, no optional, no default', () => {
    expect(squash(topLevelConst(dto, 'expectedVersion').getText())).toBe('z.number().int().min(1)');
  });

  it('takes exactly the fields the forms send', () => {
    expect([...schemaProperties('changeStatusSchema').keys()].sort()).toEqual(
      ['expectedVersion', 'reason', 'status'].sort(),
    );
    // The portal stamps neither time; the service does.
    expect([...schemaProperties('decommissionSchema').keys()].sort()).toEqual(
      ['decommissionedAt', 'expectedVersion', 'reason'].sort(),
    );
    expect([...schemaProperties('activateAssetSchema').keys()].sort()).toEqual(
      ['commissionedAt', 'expectedVersion'].sort(),
    );
  });

  it('takes the statuses the change-status form offers, and no others', () => {
    const status = schemaProperties('changeStatusSchema').get('status');
    const literals = collect(parse(`const x = ${status}`), ts.isStringLiteral).map((n) => n.text);
    expect(literals).toEqual([...CHANGE_STATUS_TARGETS]);
  });

  it.each([
    ['changeStatusSchema', CHANGE_STATUS_REASON_BOUNDS],
    ['decommissionSchema', DECOMMISSION_REASON_BOUNDS],
  ] as const)(
    "%s bounds the reason as the form does, with the platform's `plainText()` and no character class",
    (name, bounds) => {
      expect(squash(schemaProperties(name).get('reason'))).toBe(
        `plainText().min(${bounds.min}).max(${bounds.max})`,
      );
    },
  );

  // `plainText()` is the platform's, from `@rasta/contracts`, so each form's
  // reason is checked against the rule itself: every bidi control refused by
  // both, ZWNJ and the other invisible characters it admits admitted by both.
  it.each([
    ['change status', changeStatusFormSchema, CHANGE_STATUS_REASON_BOUNDS],
    ['decommission', decommissionFormSchema, DECOMMISSION_REASON_BOUNDS],
  ] as const)('the %s form refuses exactly what the service refuses', (_form, schema, bounds) => {
    const service = plainText().min(bounds.min).max(bounds.max);
    const portal = formField(schema, 'reason');
    const probes = probesFrom('دستگاه برای تعمیر خارج می‌شود', [
      ...BIDI_CONTROL_CODE_POINTS,
      ...OTHER_INVISIBLE_CODE_POINTS,
    ]);
    for (const probe of probes) {
      expect([probe, portal.safeParse(probe).success]).toEqual([
        probe,
        service.safeParse(probe).success,
      ]);
    }
    expect(probes.filter((probe) => !service.safeParse(probe).success)).toHaveLength(
      BIDI_CONTROL_CODE_POINTS.length,
    );
  });

  it("translates the service's closed refusal of a reason's characters", () => {
    for (const mapping of [CHANGE_STATUS_FIELD_MAPPING, DECOMMISSION_FIELD_MAPPING]) {
      expect(mapping.messages?.[UNSUPPORTED_CHARACTERS]).toBe(
        'این فیلد نویسهٔ جهت‌دهی نامرئی نمی‌پذیرد',
      );
    }
  });
});

describe('the transition table the forms are offered from', () => {
  const lifecycle = parse(read(...ASSET, 'lifecycle.ts'));

  /** `{ from: 'A', to: 'B', actor: 'USER', … }`, read literally. */
  const rows = collect(topLevelConst(lifecycle, 'TRANSITIONS'), ts.isObjectLiteralExpression).map(
    (literal) => {
      const field = (name: string): string => {
        const property = literal.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) && candidate.name.getText() === name,
        );
        if (!property || !ts.isStringLiteral(property.initializer)) {
          throw new Error(`a TRANSITIONS row whose \`${name}\` is not a literal`);
        }
        return property.initializer.text;
      };
      return { from: field('from'), to: field('to'), actor: field('actor') };
    },
  );

  const statuses = (() => {
    const alias = lifecycle.statements.find(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === 'AssetStatus',
    );
    if (!alias) throw new Error('no `AssetStatus`');
    return collect(alias.type, ts.isStringLiteral).map((node) => node.text);
  })();

  it('is not vacuous: the reader found the rows and every status', () => {
    expect(rows.length).toBeGreaterThan(15);
    expect(statuses).toEqual(
      expect.arrayContaining(['REGISTERED', 'ACTIVE', 'IDLE', 'OUT_OF_SERVICE', 'DECOMMISSIONED']),
    );
  });

  it('is, for a person, exactly what the portal copied — for every status', () => {
    expect(Object.keys(USER_TRANSITIONS).sort()).toEqual([...statuses].sort());
    for (const status of statuses) {
      const fromService = rows
        .filter((row) => row.from === status && row.actor === 'USER')
        .map((row) => row.to)
        .sort();
      expect([status, [...(USER_TRANSITIONS[status] ?? [])].sort()]).toEqual([status, fromService]);
    }
  });

  it('derives what the forms offer from that table', () => {
    for (const status of statuses) {
      const reachable = rows
        .filter((row) => row.from === status && row.actor === 'USER')
        .map((row) => row.to);
      expect(canDecommissionFrom(status)).toBe(reachable.includes('DECOMMISSIONED'));
      expect(canActivateFrom(status)).toBe(status === 'REGISTERED' && reachable.includes('ACTIVE'));
      for (const target of statusTargetsFrom(status)) expect(reachable).toContain(target);
    }
  });

  it('keeps ASSIGNED and IN_MAINTENANCE to events: no row lets a person move an asset into them', () => {
    for (const row of rows.filter((candidate) => candidate.actor === 'USER')) {
      expect(['ASSIGNED', 'IN_MAINTENANCE']).not.toContain(row.to);
    }
  });
});

describe('open work in another service (docs/24 Q-94)', () => {
  const lifecycleText = read(...ASSET, 'lifecycle.ts');
  const lifecycle = parse(lifecycleText);
  const refusals = topLevelConst(lifecycle, 'OPEN_WORK_REFUSALS');

  /** `STATUS: { code: 'X', … }`, read literally. */
  const byStatus = new Map(
    collect(refusals, ts.isPropertyAssignment)
      .filter((node) => ts.isObjectLiteralExpression(node.initializer))
      .map((node) => {
        const literal = node.initializer as ts.ObjectLiteralExpression;
        const code = literal.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText() === 'code',
        );
        if (!code || !ts.isStringLiteral(code.initializer)) {
          throw new Error('an OPEN_WORK_REFUSALS row whose `code` is not a literal');
        }
        return [node.name.getText(), code.initializer.text] as const;
      }),
  );

  it('is not vacuous: the reader found both statuses', () => {
    expect([...byStatus.keys()].sort()).toEqual(['ASSIGNED', 'IN_MAINTENANCE']);
  });

  it('is the set of codes the portal says in Persian, and no other', () => {
    expect([...byStatus.values()].sort()).toEqual(Object.keys(OPEN_WORK_CODES).sort());
  });

  it('is what the portal offers nothing from: no status change, no decommission, no activation', () => {
    for (const status of byStatus.keys()) {
      expect(USER_TRANSITIONS[status]).toEqual([]);
      expect(statusTargetsFrom(status)).toEqual([]);
      expect(canDecommissionFrom(status)).toBe(false);
      expect(canActivateFrom(status)).toBe(false);
    }
  });

  it('travels in the 409’s `details[].code` on the `status` path, for the portal to read', () => {
    const service = squash(serviceSource);
    expect(service).toContain("newRastaError('INVALID_STATE_TRANSITION',message,{");
    expect(service).toContain(
      "details:codes.map((code)=>({path:'status',message:OPEN_WORK_MESSAGES[code],code}))",
    );
  });

  it('has one sentence per code in the service, and the portal says the same codes', () => {
    const messages = topLevelConst(lifecycle, 'OPEN_WORK_MESSAGES');
    const keys = collect(messages, ts.isPropertyAssignment).map((node) => node.name.getText());
    expect(keys.sort()).toEqual(Object.keys(OPEN_WORK_CODES).sort());
  });

  describe('asked of the owners, not only read from the asset’s own status', () => {
    const method = (name: string): string => {
      const declaration = collect(parse(serviceSource), ts.isMethodDeclaration).find(
        (node) => node.name.getText() === name,
      );
      return declaration?.body?.getText() ?? '';
    };

    it('leaves service only through the owners’ answer: the targets are OUT_OF_SERVICE and DECOMMISSIONED', () => {
      const targets = collect(
        topLevelConst(lifecycle, 'WITHDRAWAL_TARGETS'),
        ts.isStringLiteral,
      ).map((node) => node.text);
      expect(targets.sort()).toEqual(['DECOMMISSIONED', 'OUT_OF_SERVICE']);
    });

    it('changeStatus and decommission both go through the owners’ clearance', () => {
      expect(squash(method('changeStatus'))).toContain('WITHDRAWAL_TARGETS.includes(dto.status');
      expect(squash(method('changeStatus'))).toContain('this.withWithdrawalClearance(');
      expect(squash(method('decommission'))).toContain('this.withWithdrawalClearance(');
    });

    it('asks both owners, and fails closed on anything but all-clear', () => {
      const clear = squash(method('clearForWithdrawal'));
      expect(clear).toContain('WORK_OWNERS.map((owner)=>this.clearance.ask(');
      expect(clear).toContain("outcome.status==='fulfilled'&&outcome.value.clear");
      // An owner that cannot answer is its own error, never a clear.
      expect(clear).toContain("outcome.status==='rejected'");
      expect(clear).toContain('throwunavailable??failures[0]');
    });

    it('answers "unavailable" before "blocked by open work" when the owners disagree', () => {
      // The carried-over LOW of #195: the caller cannot know the full picture
      // when one owner did not answer, so the portal's 503 sentence — "the check
      // could not be made", nothing written — is the one that must win over the
      // open-work refusal. Pinned by source order, and by the codes it prefers.
      const clear = squash(method('clearForWithdrawal')) ?? '';
      expect(clear.indexOf('throwunavailable??failures[0]')).toBeGreaterThan(-1);
      expect(clear.indexOf('throwunavailable??failures[0]')).toBeLessThan(
        clear.indexOf('throwopenWorkError('),
      );
      expect(clear).toContain("reason.code==='UPSTREAM_UNAVAILABLE'");
      expect(clear).toContain("reason.code==='UPSTREAM_TIMEOUT'");
    });

    it('checks the deadline inside the write and lifts the fences whatever happened', () => {
      const guarded = squash(method('withWithdrawalClearance'));
      expect(guarded).toContain('finally{awaitthis.releaseFences(');
      expect(squash(method('decommission'))).toContain('assertWithinDeadline()');
    });

    it('uses the fence id shape the owners’ endpoints accept', () => {
      expect(squash(method('withWithdrawalClearance'))).toContain('`TRF_${ulid()}`');
      for (const owner of ['fleet-service', 'maintenance-service']) {
        const file = readFileSync(
          join(
            ROOT,
            'services',
            owner,
            'src',
            owner === 'fleet-service' ? 'fleet' : 'maintenance',
            'transfer-clearance.ts',
          ),
          'utf8',
        );
        expect(file).toContain('TRF_[0-9A-HJKMNP-TV-Z]{26}');
      }
    });
  });

  it('is told apart from a stale version: the version is still judged first', () => {
    const body = (name: string) => {
      const declaration = collect(parse(serviceSource), ts.isMethodDeclaration).find(
        (node) => node.name.getText() === name,
      );
      return declaration?.body?.getText() ?? '';
    };
    expect(body('assertTransition')).toContain('openWorkRefusal(from, actor)');
  });
});

describe('the version is checked, and checked again in the write', () => {
  const method = (name: string): string => {
    const declaration = collect(parse(serviceSource), ts.isMethodDeclaration).find(
      (node) => node.name.getText() === name,
    );
    if (!declaration?.body) throw new Error(`no method \`${name}\``);
    return declaration.body.getText();
  };

  it.each(['activate', 'changeStatus', 'decommission'])(
    '%s compares the version before it judges the transition, so a replay is a 409 and not a 422',
    (name) => {
      const body = method(name);
      const version = body.indexOf('this.assertVersion(asset, dto.expectedVersion)');
      const transition = body.indexOf('this.assertTransition(');
      expect(version).toBeGreaterThan(-1);
      expect(transition).toBeGreaterThan(version);
    },
  );

  it.each(['activate', 'decommission'])(
    '%s guards its UPDATE on the version it was made against',
    (name) => {
      expect(squash(method(name))).toContain('{version:dto.expectedVersion}');
    },
  );

  it('changeStatus passes the version to the guarded write', () => {
    expect(squash(method('changeStatus'))).toContain('dto.reason,dto.expectedVersion');
    expect(squash(method('writeStatusChange'))).toContain(
      'expectedVersion===undefined?{}:{version:expectedVersion}',
    );
  });

  it('puts the version in the UPDATE’s WHERE, beside the status', () => {
    const repository = read(...ASSET, 'asset.repository.ts');
    expect(squash(repository)).toContain(
      'where:{id,status:expectedasnever,deletedAt:null,...where}',
    );
    expect(squash(repository)).toMatch(/where\??:\{organizationId\?:string;version\?:number\}/);
    expect(squash(repository)).toContain('data:{...data,version:{increment:1}}');
  });

  it('answers a stale version with the platform’s optimistic-lock error, whose sentence the portal translates', () => {
    const platform = read('packages', 'nest-common', 'src', 'errors', 'rasta-error.ts');
    expect(platform).toContain('was modified by another request; reload and retry');
    expect(serviceSource).toContain("RastaError.optimisticLockFailed('Asset', asset.id)");
    for (const mapping of [
      ACTIVATE_FIELD_MAPPING,
      CHANGE_STATUS_FIELD_MAPPING,
      DECOMMISSION_FIELD_MAPPING,
    ]) {
      expect(mapping.messages?.['Asset was modified by another request; reload and retry']).toBe(
        ASSET_LIFECYCLE_CONFLICT_MESSAGE,
      );
    }
  });

  it('does not let a plain status change commission a REGISTERED asset around the dossier check', () => {
    expect(squash(method('changeStatus'))).toContain(
      "asset.status==='REGISTERED'&&dto.status==='ACTIVE'",
    );
  });
});

describe('the sentences the portal says in Persian', () => {
  const SAID = ACTIVATE_FIELD_MAPPING.messages ?? {};

  it('is the dossier refusal, in each of its three shapes', () => {
    // `The asset cannot be activated without ${missing.join(' and ')}.`
    expect(serviceSource).toContain('The asset cannot be activated without ${missing.join(');
    expect(serviceSource).toContain("missing.push('an insurance policy currently in force')");
    expect(serviceSource).toContain("missing.push('an ownership title or registration card')");
    const insurance = 'an insurance policy currently in force';
    const ownership = 'an ownership title or registration card';
    for (const missing of [insurance, ownership, `${insurance} and ${ownership}`]) {
      expect(SAID[`The asset cannot be activated without ${missing}.`]).toBeTruthy();
    }
  });

  it('is the terminal-state refusal, word for word', () => {
    const lifecycle = read(...ASSET, 'lifecycle.ts');
    const sentence =
      'A DECOMMISSIONED asset cannot change status. This state is final because financial and audit records still reference the asset.';
    // `A ${from} asset cannot change status. This state is final …`
    expect(lifecycle).toContain(
      'A ${from} asset cannot change status. This state is final because financial and audit records still reference the asset.',
    );
    expect(SAID[sentence]).toBeTruthy();
  });

  it('is the "use activate" refusal, word for word', () => {
    const sentence =
      'A registered asset is commissioned with the activate command, which checks that its dossier is complete.';
    expect(serviceSource).toContain(sentence);
    expect(SAID[sentence]).toBeTruthy();
  });

  it('is said the same way by every command, so no mapping falls behind', () => {
    expect(CHANGE_STATUS_FIELD_MAPPING.messages).toEqual(ACTIVATE_FIELD_MAPPING.messages);
    expect(DECOMMISSION_FIELD_MAPPING.messages).toEqual(ACTIVATE_FIELD_MAPPING.messages);
  });
});
