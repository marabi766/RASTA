import { render } from '@testing-library/react';

import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import type { Offer } from '@/server/marketplace';

import { MemberRolesForm } from './organizations/MemberRolesForm';
import { OrganizationProfileForm } from './organizations/OrganizationProfileForm';
import { PlaceOrderForm } from './marketplace/[productId]/PlaceOrderForm';

/**
 * Parser → action → rendered error, with the real parser and the real action:
 * a form the portal refuses locally shows Persian, never a Zod sentence
 * (F3 of the #397 review). Only the page's `useActionState` is stubbed, to
 * hand the form the state its own action returned.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

let currentState: unknown = { kind: 'IDLE' };

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return { ...actual, useActionState: () => [currentState, '/x#action', false] as const };
});

const currentSession = jest.fn();
jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/money-gate', () => ({ mayDispatch: async () => true }));
const gatewayWrite = jest.fn();
jest.mock('@/server/organizations', () => ({
  ...jest.requireActual('@/server/organizations'),
  updateOrganization: (...a: unknown[]) => gatewayWrite(...a),
}));
jest.mock('@/server/members', () => ({
  ...jest.requireActual('@/server/members'),
  updateMemberRoles: (...a: unknown[]) => gatewayWrite(...a),
}));
jest.mock('@/server/place-order', () => ({
  ...jest.requireActual('@/server/place-order'),
  placeOrder: (...a: unknown[]) => gatewayWrite(...a),
}));

const { submitUpdateOrganization, submitUpdateMemberRoles } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./organizations/actions') as typeof import('./organizations/actions');
const { submitPlaceOrder } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./marketplace/[productId]/place-order-actions') as typeof import('./marketplace/[productId]/place-order-actions');

const SESSION = {
  subject: 'USR_1',
  username: 'admin',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;
const SUBMISSION = mintSubmissionId(SESSION);

function post(entries: Array<[string, string]>): FormData {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  form.set(CSRF_FIELD, SESSION.csrfToken);
  form.set(SUBMISSION_FIELD, SUBMISSION);
  return form;
}

const ZOD_ENGLISH = /must contain|Expected|Invalid|Required|received|character\(s\)|float|integer,/;

beforeEach(() => {
  currentSession.mockResolvedValue(SESSION);
  gatewayWrite.mockReset();
});

function expectPersianOnly(text: string, expected: string) {
  expect(text).toContain(expected);
  expect(text).not.toMatch(ZOD_ENGLISH);
}

describe('organization profile (parser → action → rendered)', () => {
  const ORG: Array<[string, string]> = [
    ['organizationId', 'ORG_1'],
    ['name', 'نام تازه'],
    ['shortName', ''],
    ['externalCode', ''],
  ];
  const render201 = async (field: string, expected: string) => {
    const entries = ORG.map(([key, value]): [string, string] =>
      key === field ? [key, 'ب'.repeat(field === 'externalCode' ? 65 : 201)] : [key, value],
    );
    const state = await submitUpdateOrganization({ kind: 'IDLE' }, post(entries));
    expect(state.kind).toBe('INVALID');
    expect(gatewayWrite).not.toHaveBeenCalled();
    currentState = state;
    const { container } = render(
      <OrganizationProfileForm
        organizationId="ORG_1"
        csrfToken={SESSION.csrfToken}
        submissionId={SUBMISSION}
        initialValues={{ name: 'x', shortName: '', externalCode: '' }}
      />,
    );
    expectPersianOnly(container.textContent ?? '', expected);
  };

  it('a name over 200 characters', () => render201('name', 'حداکثر ۲۰۰ نویسه مجاز است'));
  it('a short name over 200 characters', () => render201('shortName', 'حداکثر ۲۰۰ نویسه مجاز است'));
  it('an external code over 64 characters', () =>
    render201('externalCode', 'حداکثر ۶۴ نویسه مجاز است'));
});

describe('member roles (parser → action → rendered)', () => {
  it('an empty role string', async () => {
    const state = await submitUpdateMemberRoles(
      { kind: 'IDLE' },
      post([
        ['membershipId', 'MBR_2'],
        ['roles', ''],
        ['reason', 'جابه‌جایی مسئولیت'],
      ]),
    );
    expect(state.kind).toBe('INVALID');
    expect(gatewayWrite).not.toHaveBeenCalled();
    currentState = state;
    const { container } = render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="علی"
        currentRoles={['DRIVER']}
        grantableRoles={['DRIVER', 'FLEET_MANAGER']}
        csrfToken={SESSION.csrfToken}
        submissionId={SUBMISSION}
      />,
    );
    expectPersianOnly(container.textContent ?? '', 'این مقدار را وارد کنید');
  });
});

describe('place order (parser → action → rendered)', () => {
  it('a 400-digit quantity', async () => {
    const state = await submitPlaceOrder(
      { kind: 'IDLE' },
      post([
        ['offerId', 'OFR_1'],
        ['quantity', '9'.repeat(400)],
      ]),
    );
    expect(state.kind).toBe('INVALID');
    expect(gatewayWrite).not.toHaveBeenCalled();
    currentState = state;
    const offer: Offer = {
      id: 'OFR_1',
      productId: 'PRD_1',
      supplierOrganizationId: 'ORG-DEH-0002',
      unitPriceMinor: '300000',
      currency: 'IRR',
      availableQuantity: 15,
      leadTimeDays: 5,
      minimumQuantity: 2,
      supplierQualification: 'UNAVAILABLE',
    };
    const { container } = render(
      <PlaceOrderForm
        offers={[offer]}
        csrfToken={SESSION.csrfToken}
        submissionId={SUBMISSION}
        newOrderHref="/marketplace/PRD_1"
        productId="PRD_1"
        binding={{ owner: 'owner-tag', session: 'session-tag' }}
        sessionMaxAgeSeconds={3600}
      />,
    );
    expectPersianOnly(container.textContent ?? '', 'تعداد نباید بیش از');
    expect(container.textContent).not.toContain('9'.repeat(400));
  });
});
