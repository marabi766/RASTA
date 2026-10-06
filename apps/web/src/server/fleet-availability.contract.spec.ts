/**
 * @jest-environment node
 */
import { AVAILABILITY_CHOICES, DECLARE_AVAILABILITY_FIELDS } from '@/lib/fleet-availability-fields';
import { blockerWording } from '@/lib/availability-wording';
import {
  decoratorOf,
  handlerOf,
  parseSource,
  readSource,
  rolesOf,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

import {
  AVAILABILITY_BOUNDS,
  DECLARE_MAPPING,
  DECLARE_MESSAGES,
  REVOKE_MESSAGES,
  canManageAvailability,
  declareAvailabilityFormSchema,
  parseDeclareAvailabilityForm,
} from './fleet-availability';

/**
 * What the availability commands depend on, pinned to fleet-service's source —
 * the technique of `asset-records.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment a
 * copy and its original disagree. The reader refuses anything it cannot read
 * literally.
 */

const fleetDir = ['services', 'fleet-service', 'src', 'fleet'] as const;
const controller = parseSource(readSource(...fleetDir, 'fleet.controller.ts'));
const controllerText = readSource(...fleetDir, 'fleet.controller.ts');
const dto = parseSource(readSource(...fleetDir, 'dto.ts'));
const dtoText = readSource(...fleetDir, 'dto.ts');
const blocks = readSource(...fleetDir, 'dispatch-blocks.ts');
const availabilityService = readSource(...fleetDir, 'availability.service.ts');
const rastaErrors = readSource('packages', 'nest-common', 'src', 'errors', 'rasta-error.ts');

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

const COMMANDS = [
  ['declare', "'availability'"],
  ['revoke', "'availability/:id/revoke'"],
] as const;

describe('who may declare and revoke', () => {
  it.each(COMMANDS)(
    'is the same set of roles for %s as the portal offers the forms to',
    (method) => {
      const admitted = rolesOf(controller, method);
      expect(admitted.length).toBeGreaterThan(0);
      const offered = EVERY_ROLE.filter((role) => canManageAvailability([role]));
      expect(offered.sort()).toEqual(EVERY_ROLE.filter((role) => admitted.includes(role)).sort());
    },
  );

  it.each(COMMANDS)('still serves %s at the path the portal posts to', (method, path) => {
    expect(decoratorOf(controller, method, 'Post')?.arguments.map((a) => a.getText())).toEqual([
      path,
    ]);
  });

  it('serves the reads under /v1/fleet, open to any role of the organization', () => {
    const text = squash(controllerText) ?? '';
    expect(text).toContain("@Controller({path:'fleet',version:'1'})");
    // `list` is also a method of the usage controller, so the route is read as text.
    expect(text).toMatch(/@Get\('availability'\)@ApiOperation\(\{[^]*?\}\)list\(/);
    expect(
      decoratorOf(controller, 'listWindows', 'Get')?.arguments.map((a) => a.getText()),
    ).toEqual(["'availability/windows'"]);
    // No @Roles: the service answers the organization's own machines to any role.
    expect(decoratorOf(controller, 'listWindows', 'Roles')).toBeUndefined();
    expect(text).not.toMatch(/@Get\('availability'\)@Roles/);
  });
});

describe('the replay key', () => {
  it('declare reads the Idempotency-Key header, requires it, and runs under the idempotency store', () => {
    const text = squash(handlerOf(controller, 'declare').getText()) ?? '';
    expect(text).toContain("@Headers('idempotency-key')");
    expect(text).toContain('requiredIdempotencyKey(idempotencyKey)');
    expect(text).toContain('this.idempotency.execute');
    expect(text).toContain(',201,');
    expect(decoratorOf(controller, 'declare', 'ApiHeader')?.arguments[0]?.getText()).toBe(
      'IDEMPOTENCY_KEY_HEADER',
    );
    expect(squash(topLevelConst(controller, 'IDEMPOTENCY_KEY_HEADER').getText())).toMatch(
      /required:true/,
    );
  });

  it('revoke takes no key: it is state-based, and its replay is a refusal', () => {
    expect(squash(handlerOf(controller, 'revoke').getText())).not.toContain('idempotency');
    expect(availabilityService).toContain("'This availability window has already been revoked'");
  });
});

describe('the declaration body', () => {
  const properties = schemaProperties(dto, 'declareAvailabilitySchema');

  it('is strict, and takes the fields the form sends plus the asset the page supplies', () => {
    expect(squash(topLevelConst(dto, 'declareAvailabilitySchema').getText())).toMatch(
      /\.strict\(\)\.refine\(/,
    );
    expect([...properties.keys()].sort()).toEqual(
      ['assetId', 'available', 'reason', 'fromAt', 'toAt'].sort(),
    );
    const optional = [...properties].filter(([, text]) => /\.optional\(\)$/.test(text));
    expect(optional.map(([key]) => key).sort()).toEqual(['fromAt', 'toAt'].sort());
    expect(squash(properties.get('available'))).toBe('z.boolean()');
  });

  it('bounds the reason as the form does, as display text', () => {
    expect(squash(properties.get('reason'))).toBe(
      `displayText(${AVAILABILITY_BOUNDS.reason.min},${AVAILABILITY_BOUNDS.reason.max})`,
    );
  });

  it('takes the days as ISO datetimes, and refuses an end that is not after the start', () => {
    expect(squash(properties.get('fromAt'))).toBe('z.string().datetime().optional()');
    expect(squash(properties.get('toAt'))).toBe('z.string().datetime().optional()');
    expect(squash(topLevelConst(dto, 'declareAvailabilitySchema').getText())).toContain(
      '!dto.toAt||!dto.fromAt||newDate(dto.toAt)>newDate(dto.fromAt)',
    );
  });

  it('is the set of fields the form holds, one for one, less the asset', () => {
    expect([...properties.keys()].filter((key) => key !== 'assetId').sort()).toEqual(
      [...DECLARE_AVAILABILITY_FIELDS].sort(),
    );
    expect(Object.keys(DECLARE_MAPPING.paths).sort()).toEqual(
      [...DECLARE_AVAILABILITY_FIELDS].sort(),
    );
    const parsed = parseDeclareAvailabilityForm({
      available: 'true',
      reason: 'آماده به کار',
      fromAt: '2026-10-01',
      toAt: '2026-10-09',
    });
    expect(parsed.ok && Object.keys(parsed.body).sort()).toEqual(
      [...properties.keys()].filter((key) => key !== 'assetId').sort(),
    );
    expect(AVAILABILITY_CHOICES).toEqual(['false', 'true']);
  });

  it('still refuses a reason the service would, for the characters it names', () => {
    for (const bad of ['رز', '<b>x</b>', `رزرو${String.fromCodePoint(0x202e)}ی`]) {
      expect(
        declareAvailabilityFormSchema.safeParse({
          available: 'false',
          reason: bad,
          fromAt: '',
          toAt: '',
        }).success,
      ).toBe(false);
    }
  });
});

describe('the declarations list', () => {
  it('needs the asset, and carries the cursor the portal never constructs', () => {
    const properties = schemaProperties(dto, 'listAvailabilityWindowsQuerySchema');
    expect([...properties.keys()]).toEqual(['assetId']);
    expect(squash(properties.get('assetId'))).toBe('');
    expect(squash(topLevelConst(dto, 'listAvailabilityWindowsQuerySchema').getText())).toMatch(
      /cursorPaginationSchema\.extend\(\{assetId\}\)\.strict\(\)$/,
    );
  });

  it('answers a machine of another organization as one that does not exist', () => {
    // Both reads and the declare check the organization the same way, before any row is read.
    expect(availabilityService).toMatch(
      /async assertAssetVisible[\s\S]*?RastaError\.notFound\('Asset'/,
    );
    expect(squash(availabilityService)).toContain('awaitthis.assertAssetVisible(query.assetId)');
  });

  it('lists the fields of a window the portal keeps', () => {
    const start = dtoText.indexOf('export interface AvailabilityWindowView');
    const block = dtoText.slice(start, dtoText.indexOf('}', start));
    const keys = [...block.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]);
    expect(keys.sort()).toEqual(
      ['id', 'assetId', 'available', 'fromAt', 'toAt', 'reason', 'createdAt', 'revokedAt'].sort(),
    );
  });
});

describe('the blockers the portal words', () => {
  it('names every blocker code fleet-service can send, and none the portal has no sentence for', () => {
    const start = dtoText.indexOf('export interface AvailabilityBlocker');
    const block = dtoText.slice(start, dtoText.indexOf('detail: string', start));
    const codes = [...block.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
    expect(codes.sort()).toEqual(
      [
        'ASSET_STATUS',
        'IN_MAINTENANCE',
        'DISPATCH_BLOCKED',
        'ACTIVE_ASSIGNMENT',
        'DECLARED_UNAVAILABLE',
      ].sort(),
    );
    for (const code of codes) {
      // A known code never falls through to the "another blocker" sentence.
      expect(blockerWording({ code, owner: 'asset-service' }).title).not.toContain(`(${code})`);
    }
  });

  it('carries the structured cause and coverages the wording is built from', () => {
    expect(dtoText).toMatch(/cause\?: 'INSPECTION' \| 'INSURANCE'/);
    expect(dtoText).toMatch(/coverages\?: string\[\]/);
    expect(blocks).toMatch(/cause: 'INSPECTION' \| 'INSURANCE'/);
    // The insurance coverages are the four asset-service records.
    expect(blocks).toContain("'THIRD_PARTY'");
  });

  it('marks only a fleet declaration as revocable: the declared blocker is the only one with a window', () => {
    expect(blockerWording({ code: 'DECLARED_UNAVAILABLE', owner: 'fleet-service' }).imposedBy).toBe(
      'DECLARATION',
    );
    for (const code of ['ASSET_STATUS', 'IN_MAINTENANCE', 'DISPATCH_BLOCKED']) {
      expect(blockerWording({ code, owner: 'asset-service' }).imposedBy).toBe('PLATFORM');
    }
    expect(blockerWording({ code: 'ACTIVE_ASSIGNMENT', owner: 'fleet-service' }).imposedBy).toBe(
      'ASSIGNMENT',
    );
  });
});

describe('what the service says, pinned to where it says it', () => {
  it('says every sentence the portal words', () => {
    for (const sentence of [...Object.keys(DECLARE_MESSAGES), ...Object.keys(REVOKE_MESSAGES)]) {
      const source = `${dtoText}\n${availabilityService}\n${rastaErrors}`;
      expect([
        sentence,
        source.includes(`'${sentence}'`) || source.includes(`"${sentence}"`),
      ]).toEqual([sentence, true]);
    }
  });
});
