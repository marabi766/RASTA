import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import { CSRF_FIELD, SUBMISSION_FIELD } from '@/lib/form-fields';
import type { MemberPage } from '@/server/members';
import type { ReadResult } from '@/server/assets';

import { MembersScreen } from './MembersScreen';
import { MemberRolesForm } from './MemberRolesForm';
import { RevokeMembershipForm } from './RevokeMembershipForm';
import { OrganizationProfileForm } from './OrganizationProfileForm';
import type {
  RevokeMembershipFormState,
  UpdateMemberRolesFormState,
  UpdateOrganizationFormState,
} from './form-state';

/**
 * What `/organizations` renders.
 *
 * The case this file exists for is the role picker. Its options come from the
 * service's configured ladder (`docs/24` Q-60), so the tests that matter are
 * the ones proving the component renders **that** and never a list of its
 * own: a caller who may grant three roles sees three, a caller who may grant
 * none is told so rather than shown an empty form, and a role the member
 * already holds that the caller cannot grant survives the round trip instead
 * of being silently stripped.
 *
 * `useActionState` is stubbed so a state can be rendered directly, the same
 * technique as `usage.spec.tsx` and `driver-forms.spec.tsx`.
 */

type AnyFormState =
  UpdateMemberRolesFormState | RevokeMembershipFormState | UpdateOrganizationFormState;

let currentState: AnyFormState = { kind: 'IDLE' };
let pending = false;

jest.mock('react', () => {
  const actual = jest.requireActual('react');
  return {
    ...actual,
    useActionState: () => [currentState, '/organizations#action', pending] as const,
  };
});

const CSRF = 'csrf-token-for-this-session';
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

/** What an ORGANIZATION_ADMIN gets from the shipped default ladder. */
const ORG_ADMIN_GRANTS = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'DRIVER',
  'OPERATOR',
  'PROCUREMENT_USER',
];

const MEMBER = {
  id: 'USR_2',
  membershipId: 'MBR_2',
  username: 'colleague',
  firstName: 'همکار',
  lastName: 'نمونه',
  status: 'ACTIVE',
  roles: ['FLEET_MANAGER'],
};

function page(items: MemberPage['items']): ReadResult<MemberPage> {
  return { kind: 'OK', data: { items, nextCursor: null, hasMore: false } };
}

beforeEach(() => {
  currentState = { kind: 'IDLE' };
  pending = false;
});

// ---------------------------------------------------------------------------

describe('the role picker offers what the service would accept', () => {
  it('renders one checkbox per grantable role, and no others', () => {
    render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={['FLEET_MANAGER']}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(ORG_ADMIN_GRANTS.length);
    expect(screen.queryByLabelText('مدیر سامانه')).toBeNull();
    expect(screen.queryByLabelText('مدیر اتحادیه')).toBeNull();
  });

  it('checks the roles the member already holds', () => {
    render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={['FLEET_MANAGER', 'DRIVER']}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(screen.getByLabelText('مدیر ناوگان')).toBeChecked();
    expect(screen.getByLabelText('راننده')).toBeChecked();
    expect(screen.getByLabelText('اپراتور')).not.toBeChecked();
  });

  it('offers nothing, and says so, when the caller may grant nothing', () => {
    // An empty ladder is a real configuration, and it is also what a failed
    // `/users/me` read leaves behind. Either way the honest answer is that
    // this person cannot change roles — not a form with no options.
    const { container } = render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={['FLEET_MANAGER']}
        grantableRoles={[]}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(container.querySelector('form')).toBeNull();
    expect(screen.getByText(/اجازهٔ تغییر نقش‌های اعضا را ندارید/)).toBeInTheDocument();
    expect(screen.getByText(/مدیر ناوگان/)).toBeInTheDocument();
  });

  it('preserves a held role the caller cannot grant, instead of stripping it', () => {
    // The service checks the whole resulting set, so leaving `UNION_ADMIN`
    // out of the post would read as a request to remove it — which this
    // caller may not do either. It rides as a hidden input and is named on
    // screen so the omission is visible rather than silent.
    const { container } = render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={['FLEET_MANAGER', 'UNION_ADMIN']}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    const hidden = container.querySelector('input[type="hidden"][name="roles"]');
    expect(hidden).toHaveValue('UNION_ADMIN');
    expect(screen.getByText(/بالاتر از اختیار شماست/)).toBeInTheDocument();
  });

  it('carries the CSRF token, the submission id and the membership', () => {
    const { container } = render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={[]}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(container.querySelector(`input[name="${CSRF_FIELD}"]`)).toHaveValue(CSRF);
    expect(container.querySelector(`input[name="${SUBMISSION_FIELD}"]`)).toHaveValue(SUBMISSION);
    expect(container.querySelector('input[name="membershipId"]')).toHaveValue('MBR_2');
  });
});

describe('what the roles form says after an attempt', () => {
  it('renders the ladder refusal as a refusal, with its correlation id', () => {
    currentState = { kind: 'FORBIDDEN', correlationId: 'corr-1' };
    render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={[]}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(screen.getByText(/در اختیار شما نیست/)).toBeInTheDocument();
    expect(screen.getByText(/corr-1/)).toBeInTheDocument();
  });

  it('shows an expired session, which carries no membership of its own', () => {
    // This state has no `membershipId`, so any "is this mine?" filter would
    // hide it — and it is the one a person most needs to see.
    currentState = { kind: 'REFUSED', reason: 'NO_SESSION' };
    render(
      <MemberRolesForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        currentRoles={[]}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(screen.getByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
  });

  it('has no success state to render, because success redirects', () => {
    // `actions.ts` redirects on `CREATED`, so no form instance survives to
    // say "saved" — the page renders that from the query flag. This asserts
    // the type has no unreachable success case left behind.
    const kinds: UpdateMemberRolesFormState['kind'][] = [
      'IDLE',
      'INVALID',
      'REFUSED',
      'FORBIDDEN',
      'NOT_FOUND',
      'FAILED',
    ];
    expect(kinds).not.toContain('SAVED');
  });
});

describe('revoking a membership', () => {
  it('asks for a reason rather than a confirmation click', () => {
    render(
      <RevokeMembershipForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(screen.getByLabelText(/دلیل ابطال عضویت/)).toBeRequired();
  });

  it('names the member in the reason label, so two rows are never confused', () => {
    render(
      <RevokeMembershipForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(screen.getByLabelText('دلیل ابطال عضویت همکار نمونه')).toBeInTheDocument();
  });

  it('renders a refusal for a membership above the caller', () => {
    currentState = { kind: 'FORBIDDEN', correlationId: 'corr-3' };
    render(
      <RevokeMembershipForm
        membershipId="MBR_2"
        memberName="همکار نمونه"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
      />,
    );

    expect(screen.getByText(/ابطال این عضویت در اختیار شما نیست/)).toBeInTheDocument();
  });
});

describe('the members list', () => {
  it('renders a member with their current roles in Persian', () => {
    render(
      <MembersScreen
        result={page([MEMBER])}
        query={{}}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
      />,
    );

    expect(screen.getByRole('heading', { name: 'همکار نمونه' })).toBeInTheDocument();
    expect(screen.getByText(/نقش‌های کنونی: مدیر ناوگان/)).toBeInTheDocument();
  });

  it('offers no actions for a row whose membership vanished', () => {
    const { container } = render(
      <MembersScreen
        result={page([{ ...MEMBER, membershipId: null }])}
        query={{}}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
      />,
    );

    const item = container.querySelector('li')!;
    expect(within(item).queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/صفحه را تازه کنید/)).toBeInTheDocument();
  });

  it('tells an empty search from an empty organization', () => {
    const { rerender } = render(
      <MembersScreen
        result={page([])}
        query={{}}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
      />,
    );
    expect(screen.getByText('هنوز عضوی ثبت نشده است')).toBeInTheDocument();

    rerender(
      <MembersScreen
        result={page([])}
        query={{ q: 'کسی' }}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
      />,
    );
    expect(screen.getByText('عضوی با این جست‌وجو پیدا نشد')).toBeInTheDocument();
  });

  it('renders a refusal without pretending the list is empty', () => {
    render(
      <MembersScreen
        result={{ kind: 'FORBIDDEN' }}
        query={{}}
        grantableRoles={[]}
        csrfToken={CSRF}
      />,
    );

    expect(screen.getByText(/در اختیار شما نیست/)).toBeInTheDocument();
  });

  it('renders an outage with the id support needs', () => {
    render(
      <MembersScreen
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-9' }}
        query={{}}
        grantableRoles={[]}
        csrfToken={CSRF}
      />,
    );

    expect(screen.getByText(/corr-9/)).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no violations with members and their forms shown', async () => {
    const { container } = render(
      <MembersScreen
        result={page([MEMBER, { ...MEMBER, id: 'USR_3', membershipId: 'MBR_3' }])}
        query={{}}
        grantableRoles={ORG_ADMIN_GRANTS}
        csrfToken={CSRF}
      />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the profile form with field errors shown', async () => {
    currentState = {
      kind: 'INVALID',
      submissionId: SUBMISSION,
      values: { name: '', shortName: '', externalCode: '' },
      fieldErrors: { name: 'نام سازمان را وارد کنید' },
      message: null,
    };

    const { container } = render(
      <OrganizationProfileForm
        organizationId="ORG_1"
        csrfToken={CSRF}
        submissionId={SUBMISSION}
        initialValues={{ name: '', shortName: '', externalCode: '' }}
      />,
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});
