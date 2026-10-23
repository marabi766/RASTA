/**
 * @jest-environment node
 */

/**
 * `/projects` and `/projects/[id]` run as the server components they are, with
 * the reads stubbed: which reads each page makes, which commands each person is
 * drawn for a project in each status, what the closed system does to the request
 * for approval, who is drawn an authority's decision, and that a reader — or a
 * person with no organization — is drawn no write form at all.
 */

import { isValidElement, type ReactElement, type ReactNode } from 'react';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_PROJECT_ROLES: 'ORGANIZATION_ADMIN',
  WEB_PROJECT_READER_ROLES: 'FLEET_MANAGER',
});

const ORG = 'ORG-OWNER';
const mockSession = { current: null as unknown };
const mockFetched: string[] = [];
const mockAnswers: Record<string, unknown> = {};

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/projects', () => {
  const actual = jest.requireActual('@/server/projects') as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      name.startsWith('fetch') && typeof value === 'function'
        ? async () => {
            mockFetched.push(name);
            return mockAnswers[name] ?? { kind: 'NOT_FOUND' };
          }
        : value,
    ]),
  );
});

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params?: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const DetailPage = (require('./[id]/page') as { default: Page }).default;
const ListPage = (require('./page') as { default: Page }).default;
const { ProjectCommands, PolicyState } =
  require('./[id]/ProjectCommands') as typeof import('./[id]/ProjectCommands');
const { ProjectApprovals } =
  require('./[id]/ProjectApprovals') as typeof import('./[id]/ProjectApprovals');
const { ProjectDetailScreen } =
  require('./[id]/ProjectDetailScreen') as typeof import('./[id]/ProjectDetailScreen');
const { ApprovalInbox } = require('./ApprovalInbox') as typeof import('./ApprovalInbox');
const { CreateProjectForm } =
  require('./CreateProjectForm') as typeof import('./CreateProjectForm');
const { openProjectBaseline } =
  require('@/server/project-commands') as typeof import('@/server/project-commands');
const { mintFlash } = require('@/server/flash') as typeof import('@/server/flash');
/* eslint-enable @typescript-eslint/no-require-imports */

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function signedInWith(roles: string[], organization: string | null = ORG) {
  return {
    subject: 'user-1',
    username: 'u',
    organizationId: organization,
    accessToken: jwt(
      organization === null
        ? { org_ids: [] }
        : {
            org_id: organization,
            org_ids: [organization],
            org_roles: roles.map((role) => `${organization}:${role}`),
          },
    ),
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
    refreshToken: 'refresh-token-value',
    csrfToken: 'csrf-token-for-this-session',
    issuedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

function elements(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const item of node) elements(item, out);
  } else if (isValidElement(node)) {
    out.push(node);
    for (const value of Object.values(node.props as Record<string, unknown>)) elements(value, out);
  }
  return out;
}

const ofType = (tree: ReactNode, type: unknown) => elements(tree).filter((e) => e.type === type);
const propsOf = <T>(element: ReactElement | undefined): T => (element?.props ?? {}) as T;

const PROJECT = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'PRJ_1',
  title: 'بازسازی پل',
  operationType: 'خاکبرداری',
  locationDescription: 'کیلومتر ۱۲',
  estimatedCostMinor: '1500000',
  status,
  statusChangedAt: '2026-10-20T08:00:00.000Z',
  hasArea: false,
  statusReason: null,
  createdAt: '2026-10-19T08:00:00.000Z',
  scopeOfWork: 'شرح کار',
  needsSummary: null,
  version: 5,
  ...over,
});

const STEP = (over: Record<string, unknown> = {}) => ({
  id: 'APR_1',
  projectId: 'PRJ_1',
  workflowKey: 'project.execution',
  round: 1,
  stepOrder: 1,
  approvalType: 'تایید فنی',
  authorityOrganizationId: ORG,
  authorityRole: 'ORGANIZATION_ADMIN',
  authorityLabel: 'شورا',
  status: 'PENDING',
  requestedAt: null,
  decidedAt: null,
  decisionNumber: null,
  conditions: null,
  reason: null,
  version: 2,
  ...over,
});

const OPEN = { kind: 'OK', data: { kind: 'OPEN', label: 'سیاست', isSample: false, steps: [] } };
const CLOSED = { kind: 'OK', data: { kind: 'CLOSED' } };

beforeEach(() => {
  mockFetched.length = 0;
  for (const key of Object.keys(mockAnswers)) delete mockAnswers[key];
  mockSession.current = signedInWith(['ORGANIZATION_ADMIN']);
});

async function detail(
  status: string,
  options: { approvals?: unknown; policy?: unknown; project?: unknown; flash?: string } = {},
) {
  mockAnswers['fetchProject'] = options.project ?? { kind: 'OK', data: PROJECT(status) };
  mockAnswers['fetchProjectApprovals'] = options.approvals ?? { kind: 'OK', data: [] };
  mockAnswers['fetchExecutionPolicy'] = options.policy ?? OPEN;
  return DetailPage({
    params: Promise.resolve({ id: 'PRJ_1' }),
    searchParams: Promise.resolve(options.flash ? { flash: options.flash } : {}),
  });
}

const offeredIn = (tree: ReactNode): string[] =>
  Object.keys(
    propsOf<{ tokens: Record<string, unknown> }>(ofType(tree, ProjectCommands)[0]).tokens ?? {},
  ).sort();

describe('/projects/[id]', () => {
  it('sends a person with no session to sign in, and back', async () => {
    mockSession.current = null;
    await expect(detail('DRAFT')).rejects.toThrow(
      'NEXT_REDIRECT:/login?returnTo=%2Fprojects%2FPRJ_1',
    );
  });

  it.each([
    ['DRAFT', ['cancel', 'edit', 'requestApproval']],
    ['CHANGES_REQUESTED', ['cancel', 'edit', 'requestApproval']],
    ['PENDING_APPROVAL', ['cancel']],
    ['APPROVED', ['cancel', 'start']],
    ['IN_PROGRESS', ['complete']],
    ['COMPLETED', []],
    ['CANCELLED', []],
  ])('draws a %s project for its writer with %j', async (status, offered) => {
    const tree = await detail(status);
    expect(offeredIn(tree)).toEqual(offered);
  });

  it('signs each command for itself: the project, the command, the version and the status shown', async () => {
    const tree = await detail('DRAFT');
    const tokens = propsOf<{ tokens: Record<string, { baseline: string; submissionId: string }> }>(
      ofType(tree, ProjectCommands)[0],
    ).tokens;
    const session = mockSession.current as Parameters<typeof openProjectBaseline>[0];
    for (const command of ['edit', 'requestApproval', 'cancel'] as const) {
      expect(openProjectBaseline(session, tokens[command]!.baseline, command)).toMatchObject({
        targetId: 'PRJ_1',
        projectId: 'PRJ_1',
        command,
        version: 5,
        status: 'DRAFT',
      });
      // …and for no other command.
      expect(
        openProjectBaseline(
          session,
          tokens[command]!.baseline,
          command === 'edit' ? 'cancel' : 'edit',
        ),
      ).toBeNull();
      expect(tokens[command]!.submissionId).toMatch(/^sub_/);
    }
    expect(openProjectBaseline(session, tokens['edit']!.baseline, 'edit')?.digests).toMatchObject({
      title: expect.any(String),
      estimatedCost: expect.any(String),
    });
    expect(openProjectBaseline(session, tokens['cancel']!.baseline, 'cancel')?.digests).toBeNull();
  });

  it('draws the edit form from the record as the form’s own text', async () => {
    const tree = await detail('DRAFT');
    expect(
      propsOf<{ initialValues: unknown }>(ofType(tree, ProjectCommands)[0]).initialValues,
    ).toEqual({
      title: 'بازسازی پل',
      operationType: 'خاکبرداری',
      locationDescription: 'کیلومتر ۱۲',
      scopeOfWork: 'شرح کار',
      estimatedCost: '1500000',
    });
  });

  it('says the system is closed, and withholds only the request for approval', async () => {
    const tree = await detail('DRAFT', { policy: CLOSED });
    expect(offeredIn(tree)).toEqual(['cancel', 'edit']);
    const policy = propsOf<{ policy: unknown }>(ofType(tree, PolicyState)[0]).policy;
    expect(policy).toEqual(CLOSED);
  });

  it('keeps the request when the policy could not be read, and does not call that closed', async () => {
    for (const policy of [
      { kind: 'FORBIDDEN' },
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
      { kind: 'MALFORMED', correlationId: 'c' },
      { kind: 'OK', data: { kind: 'UNKNOWN' } },
    ]) {
      const tree = await detail('DRAFT', { policy });
      expect(offeredIn(tree)).toEqual(['cancel', 'edit', 'requestApproval']);
      expect(propsOf<{ policy: unknown }>(ofType(tree, PolicyState)[0]).policy).toEqual(policy);
    }
  });

  it('reads the policy only where it decides the next step', async () => {
    for (const status of ['DRAFT', 'CHANGES_REQUESTED', 'PENDING_APPROVAL']) {
      mockFetched.length = 0;
      await detail(status);
      expect(mockFetched).toContain('fetchExecutionPolicy');
    }
    for (const status of ['APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) {
      mockFetched.length = 0;
      const tree = await detail(status);
      expect(mockFetched).not.toContain('fetchExecutionPolicy');
      expect(ofType(tree, PolicyState)).toHaveLength(0);
    }
  });

  it('draws no write form for a reader, for the oversight role or for a token with no organization', async () => {
    for (const session of [
      signedInWith(['FLEET_MANAGER']),
      signedInWith(['ORGANIZATION_ADMIN', 'AUDITOR']),
      signedInWith([], null),
    ]) {
      mockSession.current = session;
      const tree = await detail('DRAFT');
      expect(ofType(tree, ProjectCommands)).toHaveLength(0);
    }
  });

  it('draws the record, the approvals and the empty commands section for a reader', async () => {
    mockSession.current = signedInWith(['FLEET_MANAGER']);
    const tree = await detail('DRAFT');
    expect(ofType(tree, ProjectDetailScreen)).toHaveLength(1);
    expect(ofType(tree, ProjectApprovals)).toHaveLength(1);
  });

  it('draws the commands for the platform administrator acting for an organization', async () => {
    const session = signedInWith(['ORGANIZATION_ADMIN']);
    session.accessToken = jwt({
      org_id: ORG,
      org_ids: [ORG],
      org_roles: [`${ORG}:FLEET_MANAGER`],
      realm_access: { roles: ['SYSTEM_ADMIN'] },
    });
    mockSession.current = session;
    expect(offeredIn(await detail('APPROVED'))).toEqual(['cancel', 'start']);
  });

  it('draws the decision forms only on a pending step this person is the authority of', async () => {
    const approvals = {
      kind: 'OK',
      data: [
        STEP({ id: 'APR_1' }),
        STEP({ id: 'APR_2', stepOrder: 2, authorityRole: 'UNION_ADMIN' }),
        STEP({ id: 'APR_3', stepOrder: 3, authorityOrganizationId: 'ORG-COUNCIL' }),
        STEP({ id: 'APR_4', stepOrder: 4, status: 'QUEUED' }),
        STEP({ id: 'APR_5', stepOrder: 5, workflowKey: 'tender.award' }),
      ],
    };
    const tree = await detail('PENDING_APPROVAL', { approvals });
    const decisions = propsOf<{
      decisions: Record<string, { grant: { baseline: string }; reject: { baseline: string } }>;
    }>(ofType(tree, ProjectApprovals)[0]).decisions;
    expect(Object.keys(decisions)).toEqual(['APR_1']);
    const session = mockSession.current as Parameters<typeof openProjectBaseline>[0];
    expect(openProjectBaseline(session, decisions['APR_1']!.grant.baseline, 'grant')).toMatchObject(
      {
        targetId: 'APR_1',
        projectId: 'PRJ_1',
        version: 2,
        status: 'PENDING',
      },
    );
    expect(openProjectBaseline(session, decisions['APR_1']!.grant.baseline, 'reject')).toBeNull();
    expect(
      openProjectBaseline(session, decisions['APR_1']!.reject.baseline, 'reject'),
    ).not.toBeNull();
  });

  it('draws a decision for an authority even when it is not allowed to write projects', async () => {
    mockSession.current = signedInWith(['FLEET_MANAGER']);
    const approvals = {
      kind: 'OK',
      data: [STEP({ authorityRole: 'FLEET_MANAGER' })],
    };
    const tree = await detail('PENDING_APPROVAL', { approvals });
    expect(
      Object.keys(propsOf<{ decisions: object }>(ofType(tree, ProjectApprovals)[0]).decisions),
    ).toEqual(['APR_1']);
    expect(ofType(tree, ProjectCommands)).toHaveLength(0);
  });

  it.each([
    [{ kind: 'NOT_FOUND' }],
    [{ kind: 'FORBIDDEN' }],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' }],
    [{ kind: 'MALFORMED', correlationId: 'c' }],
  ])(
    'draws no commands, approvals or policy for a project read that answered %j',
    async (project) => {
      const tree = await detail('DRAFT', { project });
      expect(ofType(tree, ProjectCommands)).toHaveLength(0);
      expect(ofType(tree, ProjectApprovals)).toHaveLength(0);
      expect(ofType(tree, PolicyState)).toHaveLength(0);
      expect(mockFetched).not.toContain('fetchExecutionPolicy');
    },
  );

  it('offers no command for a project the service sent without a version', async () => {
    const tree = await detail('DRAFT', {
      project: { kind: 'OK', data: PROJECT('DRAFT', { version: undefined }) },
    });
    expect(offeredIn(tree)).toEqual([]);
  });

  it('shows the confirmation only for the project it was signed for', async () => {
    const session = mockSession.current as Parameters<typeof mintFlash>[0];
    const mine = await detail('DRAFT', { flash: mintFlash(session, 'PRJ_1', 'updated') });
    expect(propsOf<{ notice?: string }>(ofType(mine, ProjectDetailScreen)[0]).notice).toBe(
      'updated',
    );
    const other = await detail('DRAFT', { flash: mintFlash(session, 'PRJ_2', 'updated') });
    expect(
      propsOf<{ notice?: string }>(ofType(other, ProjectDetailScreen)[0]).notice,
    ).toBeUndefined();
    const forged = await detail('DRAFT', { flash: 'updated' });
    expect(
      propsOf<{ notice?: string }>(ofType(forged, ProjectDetailScreen)[0]).notice,
    ).toBeUndefined();
  });
});

describe('/projects', () => {
  async function list(options: { inbox?: unknown; flash?: string } = {}) {
    mockAnswers['fetchProjects'] = {
      kind: 'OK',
      data: { items: [], nextCursor: null, hasMore: false },
    };
    mockAnswers['fetchApprovalInbox'] = options.inbox ?? {
      kind: 'OK',
      data: { items: [], nextCursor: null, hasMore: false },
    };
    return ListPage({
      searchParams: Promise.resolve(options.flash ? { flash: options.flash } : {}),
    });
  }

  it('draws the create form for a writer, with a submission id of its own', async () => {
    const tree = await list();
    const form = propsOf<{ submission: { id: string; replay: string }; csrfToken: string }>(
      ofType(tree, CreateProjectForm)[0],
    );
    expect(form.submission.id).toMatch(/^sub_/);
    expect(form.submission.replay).toMatch(/\./);
    expect(form.csrfToken).toBe('csrf-token-for-this-session');
  });

  it('draws a fresh submission id on every render', async () => {
    const first = propsOf<{ submission: { id: string } }>(
      ofType(await list(), CreateProjectForm)[0],
    );
    const second = propsOf<{ submission: { id: string } }>(
      ofType(await list(), CreateProjectForm)[0],
    );
    expect(first.submission.id).not.toBe(second.submission.id);
  });

  it.each([
    [['FLEET_MANAGER'], 'ORG-OWNER'],
    [['ORGANIZATION_ADMIN', 'AUDITOR'], 'ORG-OWNER'],
    [[], null],
  ])('draws no create form for %j acting for %j', async (roles, organization) => {
    mockSession.current = signedInWith(roles, organization);
    const tree = await list();
    expect(ofType(tree, CreateProjectForm)).toHaveLength(0);
  });

  it('gives the inbox a decision for each step the person is the authority of, and the list its own read', async () => {
    const inbox = {
      kind: 'OK',
      data: {
        items: [STEP({ id: 'APR_1' }), STEP({ id: 'APR_2', authorityOrganizationId: 'ORG-OTHER' })],
        nextCursor: null,
        hasMore: false,
      },
    };
    const tree = await list({ inbox });
    const props = propsOf<{ decisions: Record<string, unknown> }>(ofType(tree, ApprovalInbox)[0]);
    expect(Object.keys(props.decisions)).toEqual(['APR_1']);
    expect(mockFetched).toEqual(expect.arrayContaining(['fetchProjects', 'fetchApprovalInbox']));
  });

  it('draws no decisions for an inbox that could not be read', async () => {
    for (const inbox of [
      { kind: 'FORBIDDEN' },
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
    ]) {
      const tree = await list({ inbox });
      expect(propsOf<{ decisions: object }>(ofType(tree, ApprovalInbox)[0]).decisions).toEqual({});
    }
  });
});
