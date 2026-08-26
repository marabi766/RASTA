/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';

/**
 * Demo seed for identity-service.
 *
 * Deterministic on purpose: fixed identifiers mean a dashboard screenshot is
 * comparable between resets, and a failing test reproduces exactly.
 *
 * The four users mirror the accounts in the Keycloak realm import
 * (infrastructure/docker/keycloak/rasta-realm.json). Their organization ids
 * match the `active_organization_id` attribute there, so a token issued by
 * Keycloak resolves to a real membership in this database. If those two drift,
 * login succeeds but every tenant-scoped request fails — so they are seeded
 * together deliberately.
 */

const prisma = new PrismaClient();

const ORG = {
  province: 'ORG-PROVINCE-YAZD',
  union: 'ORG-UNION-YAZD',
  dehyari1: 'ORG-DEH-0001',
  dehyari2: 'ORG-DEH-0002',
} as const;

/** Roles as defined in the product document, chapter 5. */
const ROLES = [
  {
    name: 'SYSTEM_ADMIN',
    description: 'مدیر سامانه — full technical administration',
    scopeLevel: 'PLATFORM',
    isSystem: true,
  },
  {
    name: 'UNION_ADMIN',
    description: 'کارشناس مرکز مدیریت پلتفرم — operates the platform',
    scopeLevel: 'PLATFORM',
    isSystem: true,
  },
  {
    name: 'ORGANIZATION_ADMIN',
    description: 'دهیار یا نماینده مجاز — administers one organization',
    scopeLevel: 'ORGANIZATION',
    isSystem: true,
  },
  {
    name: 'FLEET_MANAGER',
    description: 'کارشناس ناوگان و نگهداری',
    scopeLevel: 'ORGANIZATION',
    isSystem: false,
  },
  {
    name: 'DRIVER',
    description: 'راننده — records usage for assigned assets only',
    scopeLevel: 'ORGANIZATION',
    isSystem: false,
  },
  {
    name: 'OPERATOR',
    description: 'اپراتور ماشین‌آلات — field operator',
    scopeLevel: 'ORGANIZATION',
    isSystem: false,
  },
  {
    name: 'PROCUREMENT_USER',
    description: 'خریدار یا درخواست‌کننده',
    scopeLevel: 'ORGANIZATION',
    isSystem: false,
  },
  { name: 'SUPPLIER', description: 'تأمین‌کننده', scopeLevel: 'SUPPLIER', isSystem: false },
  { name: 'WORKSHOP', description: 'تعمیرگاه', scopeLevel: 'SUPPLIER', isSystem: false },
  { name: 'CONTRACTOR', description: 'پیمانکار عمرانی', scopeLevel: 'SUPPLIER', isSystem: false },
  {
    // CONSTRAINT (product document, ch. 4): province oversight is aggregate-only.
    // This role must never gain a permission that reads row-level data.
    name: 'AUDITOR',
    description: 'ناظر حاکمیتی — aggregate dashboards only, never row-level data',
    scopeLevel: 'PROVINCE',
    isSystem: true,
  },
] as const;

const PERMISSIONS = [
  ['organization', 'read'],
  ['organization', 'create'],
  ['organization', 'update'],
  ['user', 'read'],
  ['user', 'create'],
  ['user', 'update'],
  ['membership', 'create'],
  ['membership', 'revoke'],
  ['role', 'assign'],
  ['asset', 'read'],
  ['asset', 'create'],
  ['asset', 'update'],
  ['asset', 'decommission'],
  ['usage', 'create'],
  ['maintenance', 'read'],
  ['maintenance', 'create'],
  ['maintenance', 'approve'],
  ['order', 'read'],
  ['order', 'create'],
  ['order', 'confirm-receipt'],
  ['wallet', 'read'],
  ['transaction', 'read'],
  ['project', 'read'],
  ['project', 'create'],
  ['tender', 'read'],
  ['tender', 'publish'],
  ['bid', 'create'],
  ['contract', 'read'],
  ['statement', 'approve'],
  ['analytics', 'read'],
  ['audit', 'read'],
] as const;

const ROLE_PERMISSIONS: Record<string, string[]> = {
  UNION_ADMIN: [
    'organization:read',
    'user:read',
    'user:create',
    'membership:create',
    'membership:revoke',
    'role:assign',
    'asset:read',
    'maintenance:read',
    'maintenance:approve',
    'order:read',
    'wallet:read',
    'transaction:read',
    'analytics:read',
    'audit:read',
  ],
  ORGANIZATION_ADMIN: [
    'organization:read',
    'user:read',
    'user:create',
    'membership:create',
    'membership:revoke',
    'role:assign',
    'asset:read',
    'asset:create',
    'asset:update',
    'asset:decommission',
    'maintenance:read',
    'maintenance:approve',
    'order:read',
    'order:create',
    'wallet:read',
    'transaction:read',
    'project:read',
    'project:create',
    'tender:read',
    'tender:publish',
    'contract:read',
    'statement:approve',
  ],
  FLEET_MANAGER: [
    'asset:read',
    'asset:create',
    'asset:update',
    'usage:create',
    'maintenance:read',
    'maintenance:create',
    'maintenance:approve',
  ],
  OPERATOR: ['asset:read', 'usage:create', 'maintenance:create'],
  DRIVER: ['asset:read', 'usage:create'],
  PROCUREMENT_USER: ['order:read', 'order:create', 'order:confirm-receipt', 'asset:read'],
  SUPPLIER: ['order:read'],
  WORKSHOP: ['maintenance:read'],
  CONTRACTOR: ['tender:read', 'bid:create', 'contract:read'],
  // Aggregate only. Deliberately holds no row-level read permission.
  AUDITOR: ['analytics:read'],
  SYSTEM_ADMIN: PERMISSIONS.map(([resource, action]) => `${resource}:${action}`),
};

const USERS = [
  {
    id: 'USR-SEED-SYSTEM-ADMIN',
    username: 'system.admin',
    email: 'system.admin@rasta.local',
    firstName: 'System',
    lastName: 'Administrator',
    organizationId: ORG.union,
    roles: ['SYSTEM_ADMIN'],
  },
  {
    id: 'USR-SEED-UNION-ADMIN',
    username: 'union.admin',
    email: 'union.admin@rasta.local',
    firstName: 'مدیر',
    lastName: 'اتحادیه',
    organizationId: ORG.union,
    roles: ['UNION_ADMIN'],
  },
  {
    id: 'USR-SEED-DEHYARI-ADMIN',
    username: 'dehyari.admin',
    email: 'dehyari.admin@rasta.local',
    firstName: 'دهیار',
    lastName: 'نمونه',
    organizationId: ORG.dehyari1,
    roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'PROCUREMENT_USER'],
  },
  {
    id: 'USR-SEED-AUDITOR',
    username: 'province.auditor',
    email: 'auditor@rasta.local',
    firstName: 'ناظر',
    lastName: 'استانداری',
    organizationId: ORG.province,
    roles: ['AUDITOR'],
  },
  {
    // Exists so tenant isolation is demonstrable against live data: this user
    // is in a different dehyari and must not see ORG-DEH-0001's records.
    id: 'USR-SEED-DEHYARI2-ADMIN',
    username: 'dehyari2.admin',
    email: 'dehyari2.admin@rasta.local',
    firstName: 'دهیار',
    lastName: 'دوم',
    organizationId: ORG.dehyari2,
    roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'],
  },
  {
    id: 'USR-SEED-OPERATOR',
    username: 'operator.one',
    email: 'operator.one@rasta.local',
    firstName: 'اپراتور',
    lastName: 'یکم',
    organizationId: ORG.dehyari1,
    roles: ['OPERATOR', 'DRIVER'],
  },
] as const;

const ORGANIZATION_REFS = [
  { id: ORG.province, name: 'استانداری یزد', type: 'GOVERNMENT', status: 'ACTIVE' },
  {
    id: ORG.union,
    name: 'اتحادیه شرکت تعاونی دهیاری‌های استان یزد',
    type: 'UNION',
    status: 'ACTIVE',
  },
  { id: ORG.dehyari1, name: 'دهیاری نمونه یک', type: 'DEHYARI', status: 'ACTIVE' },
  { id: ORG.dehyari2, name: 'دهیاری نمونه دو', type: 'DEHYARI', status: 'ACTIVE' },
];

async function main(): Promise<void> {
  console.warn('Seeding identity-service…');

  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      create: { ...role },
      update: { description: role.description, scopeLevel: role.scopeLevel },
    });
  }
  console.warn(`  roles: ${ROLES.length}`);

  for (const [resource, action] of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { resource_action: { resource, action } },
      create: {
        id: `PRM-${resource.toUpperCase()}-${action.toUpperCase()}`,
        resource,
        action,
        description: `${action} ${resource}`,
      },
      update: {},
    });
  }
  console.warn(`  permissions: ${PERMISSIONS.length}`);

  let grants = 0;
  for (const [roleName, permissionKeys] of Object.entries(ROLE_PERMISSIONS)) {
    for (const key of permissionKeys) {
      const [resource, action] = key.split(':');
      const permission = await prisma.permission.findUnique({
        where: { resource_action: { resource: resource!, action: action! } },
      });
      if (!permission) continue;
      await prisma.rolePermission.upsert({
        where: { roleName_permissionId: { roleName, permissionId: permission.id } },
        create: { roleName, permissionId: permission.id },
        update: {},
      });
      grants += 1;
    }
  }
  console.warn(`  role-permission grants: ${grants}`);

  for (const ref of ORGANIZATION_REFS) {
    await prisma.organizationRef.upsert({
      where: { id: ref.id },
      create: { ...ref, syncedAt: new Date(), sourceEvent: 'SEED' },
      update: { ...ref, syncedAt: new Date(), sourceEvent: 'SEED' },
    });
  }
  console.warn(`  organization refs: ${ORGANIZATION_REFS.length}`);

  for (const user of USERS) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        username: user.username,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        status: 'ACTIVE',
        activeOrganizationId: user.organizationId,
        createdBy: 'SEED',
        updatedBy: 'SEED',
      },
      update: { status: 'ACTIVE', activeOrganizationId: user.organizationId, updatedBy: 'SEED' },
    });

    const membershipId = `MBR-SEED-${user.username.toUpperCase().replace(/\./g, '-')}`;
    await prisma.membership.upsert({
      where: { id: membershipId },
      create: {
        id: membershipId,
        userId: user.id,
        organizationId: user.organizationId,
        roles: [...user.roles],
        status: 'ACTIVE',
        createdBy: 'SEED',
        updatedBy: 'SEED',
      },
      update: { roles: [...user.roles], status: 'ACTIVE', updatedBy: 'SEED' },
    });
  }
  console.warn(`  users + memberships: ${USERS.length}`);

  console.warn('Identity seed complete.');
  console.warn('');
  console.warn('  Demo accounts (password RastaDev!2026, set in the Keycloak realm):');
  for (const user of USERS.slice(0, 4)) {
    console.warn(`    ${user.username.padEnd(18)} ${user.roles.join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error('Identity seed failed:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
