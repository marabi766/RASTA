/**
 * @jest-environment node
 */
import {
  guardAdmitsAlone,
  literalsOf,
  parseSource,
  readSource,
  rolesOf,
  topLevelConst,
} from '@/test/service-source';

import { ROSTER_PAGE_SIZE, canListMembers } from './driver-roster';
import {
  CHANGE_STATUS_FIELD_MAPPING,
  CREATE_DRIVER_FIELD_MAPPING,
  NOT_A_MEMBER_CODE,
  NOT_A_MEMBER_TEXT,
} from './drivers';
import { mapProblemToFields } from './write';

/**
 * What the driver registration form depends on (task 095), pinned to the
 * services' source — the technique of `fleet-availability.contract.spec.ts`:
 * A-02 forbids importing `services/*\/src`, so the portal keeps copies and this
 * test fails the moment a copy and its original disagree.
 */

const fleetDir = ['services', 'fleet-service', 'src', 'fleet'] as const;
const membership = parseSource(readSource(...fleetDir, 'membership.ts'));
const access = parseSource(readSource(...fleetDir, 'access.ts'));
const identityController = parseSource(
  readSource('services', 'identity-service', 'src', 'identity', 'identity.controller.ts'),
);
/** Where the controller's `@Roles(...MEMBERSHIP_ADMIN_ROLES)` list is declared. */
const identityRoleLists = parseSource(
  readSource('services', 'identity-service', 'src', 'identity', 'live-authority.ts'),
);
const pagination = parseSource(
  readSource('packages', 'contracts', 'src', 'common', 'pagination.ts'),
);

const literal = (source: ReturnType<typeof parseSource>, name: string): string => {
  const [value, ...rest] = literalsOf(topLevelConst(source, name).getText());
  if (value === undefined || rest.length > 0) throw new Error(`\`${name}\` is not one literal`);
  return value;
};

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
  'SUPPLIER',
  'WORKSHOP',
];

describe('the not-a-member refusal (fleet-service membership.ts)', () => {
  it('is translated by its closed code, the one fleet-service sends', () => {
    expect(literal(membership, 'NOT_A_MEMBER')).toBe(NOT_A_MEMBER_CODE);
    expect(CREATE_DRIVER_FIELD_MAPPING.byDetailCode?.[NOT_A_MEMBER_CODE]).toBe(NOT_A_MEMBER_TEXT);
    expect(CHANGE_STATUS_FIELD_MAPPING.byDetailCode?.[NOT_A_MEMBER_CODE]).toBe(NOT_A_MEMBER_TEXT);
  });

  it('and by its sentence, should a detail ever arrive without the code', () => {
    const sentence = literal(membership, 'NOT_A_MEMBER_MESSAGE');
    expect(CREATE_DRIVER_FIELD_MAPPING.messages?.[sentence]).toBe(NOT_A_MEMBER_TEXT);
    expect(CHANGE_STATUS_FIELD_MAPPING.messages?.[sentence]).toBe(NOT_A_MEMBER_TEXT);
  });

  it('reaches both forms that can meet it: the field on registration, a banner on reactivation', () => {
    const sentence = literal(membership, 'NOT_A_MEMBER_MESSAGE');
    const problem = {
      code: 'BUSINESS_RULE_VIOLATION',
      message: sentence,
      details: [{ path: 'userId', message: sentence, code: NOT_A_MEMBER_CODE }],
    };
    expect(mapProblemToFields(problem, CREATE_DRIVER_FIELD_MAPPING)).toEqual({
      fieldErrors: { userId: NOT_A_MEMBER_TEXT },
      message: null,
    });
    expect(mapProblemToFields(problem, CHANGE_STATUS_FIELD_MAPPING)).toEqual({
      fieldErrors: {},
      message: NOT_A_MEMBER_TEXT,
    });
  });
});

describe('the member picker', () => {
  it('is offered to exactly the roles identity-service lets list members (GET /v1/users)', () => {
    const admitted = rolesOf(identityController, 'list', identityRoleLists);
    for (const role of EVERY_ROLE) {
      expect({ role, offered: canListMembers([role]) }).toEqual({
        role,
        offered: guardAdmitsAlone(role, admitted),
      });
    }
  });

  it('only to roles that see every driver of the organization, so the exclusion is whole', () => {
    // A role scoped to its own driver record would read one row and offer
    // everyone else as "not yet a driver".
    const supervisors = literalsOf(topLevelConst(access, 'FLEET_SUPERVISOR_ROLES').getText());
    expect(supervisors.length).toBeGreaterThan(0);
    for (const role of EVERY_ROLE.filter((candidate) => canListMembers([candidate]))) {
      expect({ role, supervisor: supervisors.includes(role) }).toEqual({ role, supervisor: true });
    }
  });

  it('asks for pages the services accept', () => {
    const max = Number(topLevelConst(pagination, 'MAX_PAGE_SIZE').getText().replace(/_/g, ''));
    expect(Number.isInteger(max)).toBe(true);
    expect(ROSTER_PAGE_SIZE).toBeLessThanOrEqual(max);
  });
});
