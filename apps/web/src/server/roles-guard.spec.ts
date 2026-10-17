/**
 * @jest-environment node
 */
import { readSource, squash } from '@/test/service-source';

import { canChangeAssetStatus, canDecommissionAsset } from './asset-lifecycle-commands';
import { canManageAssets } from './asset-commands';
import { canAttachAssetDocuments } from './asset-documents';
import { canRecordAssetCompliance } from './asset-records';
import { canManageDrivers } from './drivers';
import { canManageAvailability } from './fleet-availability';
import { canManageMaintenance, canReportMaintenance } from './maintenance-commands';
import { canPlaceOrder } from './place-order';
import { tokenWriteRoles } from './realm-roles';
import { OVERSIGHT_ROLE, rolesGuardAdmits, SUPER_ROLE } from './roles-guard';

/**
 * PR 325 review 1, finding 2: every write form's "may this person use it" is
 * `RolesGuard`'s rule — the oversight role refused unless named, whatever else
 * is held; the administrator admitted wherever roles are named — not a bare
 * "holds one of the listed roles".
 */

const guard = squash(readSource('packages', 'nest-common', 'src', 'guards', 'roles.guard.ts'))!;

describe('the mirror is the guard', () => {
  it('names the same two roles', () => {
    expect(guard).toContain(`staticreadonlySUPER_ROLE='${SUPER_ROLE}';`);
    expect(guard).toContain(`staticreadonlyOVERSIGHT_ROLE='${OVERSIGHT_ROLE}';`);
  });

  it('refuses the oversight role before it admits the administrator, unless the route names it', () => {
    const oversight = guard.indexOf('if(context.roles.includes(RolesGuard.OVERSIGHT_ROLE))');
    const named = guard.indexOf('constnamed=required?.includes(RolesGuard.OVERSIGHT_ROLE)??false;');
    const admin = guard.indexOf('if(context.roles.includes(RolesGuard.SUPER_ROLE))returntrue;');
    expect(oversight).toBeGreaterThan(-1);
    expect(named).toBeGreaterThan(oversight);
    expect(admin).toBeGreaterThan(named);
    expect(guard).toContain('constgranted=required.some((role)=>context.roles.includes(role));');
  });
});

describe('rolesGuardAdmits', () => {
  const REQUIRED = ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'];

  it.each<[string, string[], boolean]>([
    ['a listed role', ['FLEET_MANAGER'], true],
    ['an unlisted role', ['DRIVER'], false],
    ['no role', [], false],
    ['the administrator alone', ['SYSTEM_ADMIN'], true],
    ['an unlisted role with the administrator', ['DRIVER', 'SYSTEM_ADMIN'], true],
    ['the oversight role alone', ['AUDITOR'], false],
    ['a listed role with the oversight role', ['FLEET_MANAGER', 'AUDITOR'], false],
    ['the administrator with the oversight role', ['SYSTEM_ADMIN', 'AUDITOR'], false],
  ])('%s → %s', (_name, roles, admitted) => {
    expect(rolesGuardAdmits(roles, REQUIRED)).toBe(admitted);
  });

  it('admits the oversight role on a route that names it', () => {
    expect(rolesGuardAdmits(['AUDITOR'], ['AUDITOR'])).toBe(true);
    expect(rolesGuardAdmits(['AUDITOR', 'DRIVER'], ['AUDITOR', 'FLEET_MANAGER'])).toBe(true);
  });
});

/** Every write form's helper, with one role its route lists and one it does not. */
const HELPERS: [string, (roles: readonly string[]) => boolean, string, string][] = [
  ['canManageDrivers', canManageDrivers, 'FLEET_MANAGER', 'DRIVER'],
  ['canManageAssets', canManageAssets, 'FLEET_MANAGER', 'DRIVER'],
  ['canRecordAssetCompliance', canRecordAssetCompliance, 'FLEET_MANAGER', 'DRIVER'],
  ['canAttachAssetDocuments', canAttachAssetDocuments, 'FLEET_MANAGER', 'DRIVER'],
  ['canManageAvailability', canManageAvailability, 'FLEET_MANAGER', 'DRIVER'],
  ['canChangeAssetStatus', canChangeAssetStatus, 'FLEET_MANAGER', 'DRIVER'],
  ['canDecommissionAsset', canDecommissionAsset, 'ORGANIZATION_ADMIN', 'FLEET_MANAGER'],
  ['canReportMaintenance', canReportMaintenance, 'DRIVER', 'SUPPLIER'],
  ['canManageMaintenance', canManageMaintenance, 'FLEET_MANAGER', 'DRIVER'],
  ['canPlaceOrder', canPlaceOrder, 'PROCUREMENT_USER', 'DRIVER'],
];

describe.each(HELPERS)('%s follows the guard', (_name, can, listed, unlisted) => {
  it('a listed role: offered', () => expect(can([listed])).toBe(true));
  it('an unlisted role: not offered', () => expect(can([unlisted])).toBe(false));
  it('a listed role with AUDITOR: not offered — the guard refuses the oversight role first', () => {
    expect(can([listed, 'AUDITOR'])).toBe(false);
  });
  it('an unlisted scoped role with SYSTEM_ADMIN: offered — the administrator override', () => {
    expect(can([unlisted, 'SYSTEM_ADMIN'])).toBe(true);
  });
  it('SYSTEM_ADMIN alone: offered', () => expect(can(['SYSTEM_ADMIN'])).toBe(true));
  it('SYSTEM_ADMIN with AUDITOR: not offered', () => {
    expect(can(['SYSTEM_ADMIN', 'AUDITOR'])).toBe(false);
  });
});

describe('tokenWriteRoles — a write needs the organization it is for', () => {
  const ORG = 'ORG-DEH-0001';
  const jwt = (claims: unknown): string =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

  it('a token resolving to an organization: its roles there, with the global ones', () => {
    expect(
      tokenWriteRoles(
        jwt({
          org_id: ORG,
          org_ids: [ORG],
          org_roles: [`${ORG}:DRIVER`],
          realm_access: { roles: ['SYSTEM_ADMIN'] },
        }),
      ),
    ).toEqual(['DRIVER', 'SYSTEM_ADMIN']);
  });

  it('the global administrator with no organization: none — a tenant-scoped write cannot run', () => {
    expect(tokenWriteRoles(jwt({ realm_access: { roles: ['SYSTEM_ADMIN'] } }))).toBeNull();
  });

  it('the global administrator naming an organization it holds no role in: none (TENANT_MISMATCH)', () => {
    expect(
      tokenWriteRoles(
        jwt({
          org_id: ORG,
          org_ids: [ORG],
          org_roles: [],
          realm_access: { roles: ['SYSTEM_ADMIN'] },
        }),
      ),
    ).toBeNull();
  });
});
