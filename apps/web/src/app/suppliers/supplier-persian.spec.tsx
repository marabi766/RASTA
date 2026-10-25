import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';

import * as nav from '../nav';
import * as supplierCommands from '@/lib/supplier-commands';
import * as supplierFields from '@/lib/supplier-fields';
import * as unconfirmed from '@/lib/unconfirmed-write';
import { SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import type { SupplierFormState } from './supplier-form-state';

/**
 * Persian wording (docs/16 § ۱۶٫۱۱, pre-review-checklist item 19): nothing the
 * supplier screens say carries U+0654 or a hamza letter (أ إ ؤ ئ). Not only the
 * new notice: every string the touched screens render — labels, messages,
 * statuses, the shared unconfirmed-write sentence, session refusals — is checked,
 * from the exported values and from the rendered forms in every state.
 */

jest.mock('./supplier-actions', () => ({
  submitRegisterSupplier: jest.fn(),
  submitQualificationRequest: jest.fn(),
  submitApproveQualification: jest.fn(),
  submitRejectQualification: jest.fn(),
  submitSuspendSupplier: jest.fn(),
  submitReinstateSupplier: jest.fn(),
  reconcileSupplierWrite: jest.fn(),
}));

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const HAMZA = /[ٔأإؤئ]/;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

describe('the exported wording of the supplier screens', () => {
  it.each([
    ['lib/supplier-fields', supplierFields],
    ['lib/supplier-commands', supplierCommands],
    ['lib/unconfirmed-write', unconfirmed],
    ['lib/session-refusal messages', SESSION_REFUSAL_MESSAGES],
    ['app/nav (the shared navigation)', nav],
  ])('%s has no combining or hamza letters', (_name, exported) => {
    const offending = strings(exported).filter((text) => HAMZA.test(text));
    expect(offending).toEqual([]);
  });
});

describe('the source of the touched screens', () => {
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(entry) && !/\.spec\./.test(entry) ? [full] : [];
    });
  const files = [
    ...walk(path.join(root, 'suppliers')),
    path.join(root, '..', 'lib', 'supplier-fields.ts'),
    path.join(root, '..', 'lib', 'supplier-commands.ts'),
    path.join(root, '..', 'lib', 'unconfirmed-write.ts'),
    path.join(root, 'UnconfirmedWriteAlert.tsx'),
    path.join(root, 'nav.ts'),
    path.join(root, 'PortalSidebar.tsx'),
  ];

  it('covers the screens and is not empty', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((file) => [path.relative(root, file), file]))('%s', (_name, file) => {
    expect(readFileSync(file as string, 'utf8')).not.toMatch(HAMZA);
  });
});

describe('the forms, in every state', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const forms = require('./SupplierForms') as typeof import('./SupplierForms');
  const BOUND = {
    supplierId: 'SUP_1',
    csrfToken: 'csrf',
    submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
    baseline: 'signed',
  };
  const draw = (held: boolean) => [
    <forms.RegisterSupplierForm
      key="r"
      csrfToken="csrf"
      submissionId={BOUND.submissionId}
      held={held}
    />,
    <forms.SubmitQualificationForm
      key="s"
      {...BOUND}
      held={held}
      capabilities={[...supplierFields.SUPPLIER_CAPABILITIES]}
    />,
    <forms.ApproveQualificationForm
      key="a"
      {...BOUND}
      held={held}
      capabilityLabel={supplierFields.supplierCapabilityLabel('GOODS_SUPPLY')}
    />,
    <forms.RejectQualificationForm
      key="j"
      {...BOUND}
      held={held}
      capabilityLabel={supplierFields.supplierCapabilityLabel('GOODS_SUPPLY')}
    />,
    <forms.SuspendSupplierForm key="u" {...BOUND} held={held} />,
    <forms.ReinstateSupplierForm key="i" {...BOUND} held={held} />,
  ];

  it.each([false, true])('say nothing with a hamza (held: %s)', (held) => {
    for (const element of draw(held)) {
      const { container, unmount } = render(element);
      expect(container.textContent ?? '').not.toMatch(HAMZA);
      unmount();
    }
  });

  const STATES: readonly SupplierFormState<unknown, string>[] = [
    { kind: 'BUSY' },
    { kind: 'NOT_CHECKED' },
    { kind: 'CAPACITY' },
    { kind: 'UNCONFIRMED', correlationId: 'c' },
    { kind: 'FAILED', status: 503, correlationId: 'c' },
    { kind: 'FAILED', status: 429, correlationId: 'c' },
    { kind: 'FORBIDDEN', correlationId: 'c' },
    { kind: 'NOT_FOUND', correlationId: 'c' },
    { kind: 'REFUSED', reason: 'BASELINE' },
    { kind: 'REFUSED', reason: 'CSRF' },
    { kind: 'REFUSED', reason: 'SUBMISSION' },
    { kind: 'REFUSED', reason: 'NO_SESSION' as never },
  ];

  // Every answer, on every form, drawn while the slot is held and while it is open.
  it.each(
    [false, true].flatMap((held) => STATES.map((state) => [held, state.kind, state] as const)),
  )('say nothing with a hamza when held is %s and the answer is %s', async (held, _kind, state) => {
    const { act } = await import('@testing-library/react');
    const actions = jest.requireMock('./supplier-actions') as Record<string, jest.Mock>;
    for (const mock of Object.values(actions)) mock.mockResolvedValue(state);
    for (const element of draw(held)) {
      const { container, unmount } = render(element);
      await act(async () => {
        container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
      });
      expect(container.textContent ?? '').not.toMatch(HAMZA);
      unmount();
    }
  });
});

describe('the shared navigation both supplier screens render', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PortalSidebar } = require('../PortalSidebar') as typeof import('../PortalSidebar');
  const jwt = (claims: unknown): string =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const sessionWith = (roles: readonly string[]) => ({
    subject: 'user-1',
    username: 'u',
    organizationId: 'ORG-1',
    accessToken: jwt({
      org_id: 'ORG-1',
      org_ids: ['ORG-1'],
      org_roles: roles.map((role) => `ORG-1:${role}`),
      realm_access: { roles },
    }),
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  });

  // Whatever the role, the sidebar of /suppliers and /suppliers/[id] is this component.
  it.each([
    ['a supplier', ['SUPPLIER']],
    ['a platform operator', ['PLATFORM_OPERATOR', 'PLATFORM_ADMIN']],
    ['a project manager and contractor', ['PROJECT_MANAGER', 'CONTRACTOR', 'ORG_ADMIN']],
  ])('%s sees no hamza in the sidebar, on either supplier screen', (_name, roles) => {
    // Both screens pass `currentHref="/suppliers"` (pinned in supplier-unresolved-pages.spec.ts).
    const { container, unmount } = render(
      <PortalSidebar session={sessionWith(roles)} currentHref="/suppliers" />,
    );
    expect(container.textContent ?? '').not.toMatch(HAMZA);
    unmount();
  });

  it('draws the supplier entry, spelled without a hamza', () => {
    const { container } = render(
      <PortalSidebar session={sessionWith(['SUPPLIER'])} currentHref="/suppliers" />,
    );
    expect(container.textContent).toContain('تامین‌کنندگان');
  });
});
