/* eslint-disable no-console */
import { PrismaClient } from '../src/generated/prisma';
import { toLabel } from '../src/organization/organization.repository';

/**
 * Demo seed for organization-service.
 *
 * Identifiers match identity-service's seed exactly. If the two drift, a token
 * resolves to an organization this service has never heard of — login succeeds
 * and every subsequent request fails, which is a confusing thing to debug.
 *
 * The tree is deliberately more than two levels deep. A flat list would let
 * subtree scoping look correct while doing nothing:
 *
 *   استانداری یزد                          (province, root)
 *   ├── اتحادیه                            (union — the platform operator)
 *   └── شهرستان یزد                        (county)
 *       ├── دهیاری نمونه یک                (dehyari)
 *       └── دهیاری نمونه دو                (dehyari)
 *
 * dehyari.admin sits in "دهیاری نمونه یک" and must not see its sibling.
 */

/**
 * The repo-root .env names each service's database explicitly
 * (DATABASE_URL_ORGANIZATION), so a single file can describe every service without
 * any of them being able to open another's database by accident (ADR-005).
 * The running service maps this in its env loader; the seed has no such
 * loader, so it resolves the same variable itself.
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ORGANIZATION;
  if (!url) {
    throw new Error(
      'Set DATABASE_URL or DATABASE_URL_ORGANIZATION. ' +
        'Run via `pnpm db:seed`, which loads the repo-root .env.',
    );
  }
  return url;
}

const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

interface SeedOrganization {
  id: string;
  name: string;
  shortName?: string;
  type:
    | 'DEHYARI'
    | 'MUNICIPALITY'
    | 'UNION'
    | 'COOPERATIVE'
    | 'COMPANY'
    | 'GOVERNMENT'
    | 'PRIVATE'
    | 'NATIONAL_ORGANIZATION';
  parentId: string | null;
  externalCode?: string;
  metadata?: Record<string, unknown>;
  location?: {
    city: string;
    province: string;
    latitude: number;
    longitude: number;
  };
}

/** Ordered parents-first, so each node's parent path already exists. */
const ORGANIZATIONS: SeedOrganization[] = [
  {
    id: 'ORG-PROVINCE-YAZD',
    name: 'استانداری یزد',
    shortName: 'استانداری',
    type: 'GOVERNMENT',
    parentId: null,
    externalCode: 'IR-YAZD',
    metadata: { role: 'oversight', note: 'aggregate dashboards only' },
    location: { city: 'یزد', province: 'یزد', latitude: 31.8974, longitude: 54.3569 },
  },
  {
    id: 'ORG-UNION-YAZD',
    name: 'اتحادیه شرکت تعاونی دهیاری‌های استان یزد',
    shortName: 'اتحادیه',
    type: 'UNION',
    parentId: 'ORG-PROVINCE-YAZD',
    externalCode: 'IR-YAZD-UNION',
    metadata: { role: 'platform-operator' },
    location: { city: 'یزد', province: 'یزد', latitude: 31.9037, longitude: 54.3675 },
  },
  {
    id: 'ORG-COUNTY-YAZD',
    name: 'شهرستان یزد',
    type: 'GOVERNMENT',
    parentId: 'ORG-PROVINCE-YAZD',
    externalCode: 'IR-YAZD-C01',
    location: { city: 'یزد', province: 'یزد', latitude: 31.8912, longitude: 54.3502 },
  },
  {
    id: 'ORG-DEH-0001',
    name: 'دهیاری نمونه یک',
    type: 'DEHYARI',
    parentId: 'ORG-COUNTY-YAZD',
    externalCode: 'IR-YAZD-D0001',
    metadata: { households: 420 },
    location: { city: 'یزد', province: 'یزد', latitude: 31.8501, longitude: 54.2903 },
  },
  {
    id: 'ORG-DEH-0002',
    name: 'دهیاری نمونه دو',
    type: 'DEHYARI',
    parentId: 'ORG-COUNTY-YAZD',
    externalCode: 'IR-YAZD-D0002',
    metadata: { households: 310 },
    location: { city: 'یزد', province: 'یزد', latitude: 31.942, longitude: 54.418 },
  },
];

/**
 * Governance policy.
 *
 * CONSTRAINT (product document, ch. 4 and 5.14): the platform creates no new
 * decision-making authority. These rows are *examples of the shape*, not
 * approved values — every one carries a description saying so, and the real
 * values are an open question (docs/24, Q-02) awaiting the client's legal
 * review. Nothing here is a default the platform invented for itself.
 *
 * These sit on the **root** organization, not on the union, and the reason is
 * worth stating because it is easy to get wrong:
 *
 *   Policy inheritance follows the *tree*. The union operates the platform,
 *   but structurally it is a sibling of the county, not an ancestor of the
 *   dehyaris beneath it — so a policy placed on the union would inherit to
 *   nobody. Testing this against real data is how the mistake surfaced.
 *
 *   So the two concerns are separated: *who may set* a platform-wide policy is
 *   a role question (UNION_ADMIN, enforced in OrganizationService.setPolicy),
 *   while *where it lives* is a tree question (the root, so it reaches
 *   everyone). An organization lower down can still override its own copy.
 */
const POLICIES = [
  {
    organizationId: 'ORG-PROVINCE-YAZD',
    key: 'approval.project.required',
    value: true,
    description: 'نمونه — نیازمند تصویب. Sample value pending legal review (docs/24 Q-02).',
  },
  {
    organizationId: 'ORG-PROVINCE-YAZD',
    key: 'approval.project.threshold_minor',
    value: '5000000000',
    description:
      'نمونه — نیازمند تصویب. Sample threshold in rial pending legal review (docs/24 Q-02).',
  },
  {
    organizationId: 'ORG-PROVINCE-YAZD',
    key: 'procurement.aggregation.window_days',
    value: 7,
    description: 'نمونه — نیازمند تصویب. Sample demand-aggregation window (docs/24 Q-10).',
  },
  {
    organizationId: 'ORG-PROVINCE-YAZD',
    key: 'order.receipt_confirmation.days',
    value: 3,
    description:
      'نمونه — نیازمند تصویب. Sample confirmation window; no auto-confirmation (docs/24 Q-11).',
  },
];

const CONTACTS = [
  {
    id: 'CNT-SEED-UNION-ADMIN',
    organizationId: 'ORG-UNION-YAZD',
    kind: 'ADMINISTRATIVE' as const,
    displayName: 'دبیرخانه اتحادیه',
    phone: '03500000000',
    email: 'info@rasta.local',
    isPrimary: true,
  },
  {
    id: 'CNT-SEED-DEH1-ADMIN',
    organizationId: 'ORG-DEH-0001',
    kind: 'ADMINISTRATIVE' as const,
    displayName: 'دفتر دهیاری نمونه یک',
    phone: '09120000001',
    isPrimary: true,
  },
];

async function main(): Promise<void> {
  console.warn('Seeding organization-service…');

  const pathById = new Map<string, string>();

  for (const org of ORGANIZATIONS) {
    const parentPath = org.parentId ? pathById.get(org.parentId) : null;
    if (org.parentId && !parentPath) {
      throw new Error(`Parent ${org.parentId} must be seeded before ${org.id}`);
    }

    const label = toLabel(org.id);
    const path = parentPath ? `${parentPath}.${label}` : label;
    const depth = path.split('.').length - 1;
    pathById.set(org.id, path);

    await prisma.organization.upsert({
      where: { id: org.id },
      create: {
        id: org.id,
        name: org.name,
        shortName: org.shortName ?? null,
        type: org.type,
        status: 'ACTIVE',
        parentId: org.parentId,
        externalCode: org.externalCode ?? null,
        metadata: (org.metadata ?? {}) as object,
        depth,
        createdBy: 'SEED',
        updatedBy: 'SEED',
      },
      update: {
        name: org.name,
        type: org.type,
        parentId: org.parentId,
        depth,
        updatedBy: 'SEED',
      },
    });

    // The ltree column is `Unsupported` in Prisma, so it is set with raw SQL.
    await prisma.$executeRaw`
      UPDATE organization SET path = ${path}::ltree WHERE id = ${org.id}
    `;

    if (org.location) {
      const locationId = `LOC-SEED-${label}`;
      await prisma.organizationLocation.upsert({
        where: { id: locationId },
        create: {
          id: locationId,
          organizationId: org.id,
          kind: 'PRIMARY',
          city: org.location.city,
          province: org.location.province,
        },
        update: { city: org.location.city, province: org.location.province },
      });

      // ST_MakePoint takes longitude first. Reversing these is the classic
      // PostGIS bug and would put Yazd in the Indian Ocean.
      await prisma.$executeRaw`
        UPDATE organization_location
        SET point = ST_SetSRID(ST_MakePoint(${org.location.longitude}, ${org.location.latitude}), 4326)::geography
        WHERE id = ${locationId}
      `;
    }

    console.warn(`  ${'  '.repeat(depth)}${org.name} (${org.type})`);
  }

  for (const policy of POLICIES) {
    const id = `POL-SEED-${policy.key.replace(/[^a-z0-9]/gi, '-').toUpperCase()}`;
    await prisma.organizationPolicy.upsert({
      where: { id },
      create: {
        id,
        organizationId: policy.organizationId,
        key: policy.key,
        value: policy.value as object,
        inheritable: true,
        description: policy.description,
        createdBy: 'SEED',
        updatedBy: 'SEED',
      },
      // organizationId is included deliberately. A seed must converge on the
      // declared state, not merely create it: omitting a field here means an
      // already-seeded row silently keeps its old value, and the seed stops
      // being idempotent.
      update: {
        organizationId: policy.organizationId,
        value: policy.value as object,
        description: policy.description,
        updatedBy: 'SEED',
      },
    });
  }
  console.warn(`  policies: ${POLICIES.length} (all marked as samples pending approval)`);

  for (const contact of CONTACTS) {
    await prisma.organizationContact.upsert({
      where: { id: contact.id },
      create: {
        id: contact.id,
        organizationId: contact.organizationId,
        kind: contact.kind,
        displayName: contact.displayName,
        phone: contact.phone ?? null,
        email: 'email' in contact ? (contact.email ?? null) : null,
        isPrimary: contact.isPrimary,
      },
      update: { displayName: contact.displayName },
    });
  }
  console.warn(`  contacts: ${CONTACTS.length}`);

  console.warn('Organization seed complete.');
}

main()
  .catch((error) => {
    console.error('Organization seed failed:', error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
