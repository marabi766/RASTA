import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import type {
  AvailabilityWindow,
  AvailabilityWindows,
  MachineAvailability,
} from '@/server/fleet-availability';

import { AssetAvailability } from './AssetAvailability';

/**
 * The availability section: whether the machine can be dispatched, every reason
 * it cannot with the service that owns it — and the one control, drawn only
 * around a declaration still in force or not yet begun, never around a block
 * the platform imposes. Each declaration's state is judged on the clock the page
 * was handed (the server's), never the machine's.
 */

const NOW = new Date('2026-10-15T08:00:00.000Z');
const ASSET = 'AST_01J00000000000000000000000';

const machine = (over: Partial<MachineAvailability> = {}): MachineAvailability => ({
  assetId: ASSET,
  available: true,
  blockers: [],
  currentAssignment: null,
  ...over,
});

const declaration = (over: Partial<AvailabilityWindow> = {}): AvailabilityWindow => ({
  id: 'AVW_1',
  assetId: ASSET,
  available: false,
  fromAt: '2026-10-01T00:00:00.000Z',
  toAt: '2026-10-31T00:00:00.000Z',
  reason: 'رزرو برای پروژهٔ راه‌سازی',
  createdAt: '2026-09-30T00:00:00.000Z',
  revokedAt: null,
  ...over,
});

const ok = <T,>(data: T) => ({ kind: 'OK' as const, data });
const windows = (items: AvailabilityWindow[], hasMore = false): AvailabilityWindows => ({
  items,
  hasMore,
});

const PLATFORM_BLOCKERS: MachineAvailability['blockers'] = [
  {
    code: 'DISPATCH_BLOCKED',
    owner: 'asset-service',
    detail: 'x',
    cause: 'INSURANCE',
    coverages: ['THIRD_PARTY'],
  },
  { code: 'DISPATCH_BLOCKED', owner: 'asset-service', detail: 'y', cause: 'INSPECTION' },
  { code: 'IN_MAINTENANCE', owner: 'maintenance-service', detail: 'z' },
  {
    code: 'ASSET_STATUS',
    owner: 'asset-service',
    detail: 'The machine is in state OUT_OF_SERVICE',
  },
];

const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

const REVOKE = (window: AvailabilityWindow) => (
  <button type="submit" data-revoke-for={window.id}>
    ابطال این اعلام
  </button>
);

describe('whether the machine can be dispatched', () => {
  it('says it is free, and lists no blocker', () => {
    render(<AssetAvailability availability={ok(machine())} windows={ok(windows([]))} now={NOW} />);
    expect(screen.getByText('برای اعزام آزاد است')).toBeInTheDocument();
    expect(screen.queryByTestId('availability-blockers')).toBeNull();
  });

  it('lists every blocker, worded from its cause and coverages, with who owns it and who can lift it', () => {
    render(
      <AssetAvailability
        availability={ok(machine({ available: false, blockers: PLATFORM_BLOCKERS }))}
        windows={ok(windows([]))}
        assetStatus="OUT_OF_SERVICE"
        now={NOW}
      />,
    );
    const list = screen.getByTestId('availability-blockers');
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(list.textContent).toContain('بیمه‌نامهٔ منقضی‌شده: شخص ثالث');
    expect(list.textContent).toContain('آخرین معاینهٔ فنی مردود شده است');
    expect(list.textContent).toContain('دارایی برای تعمیر از مدار خارج شده است');
    expect(list.textContent).toContain('وضعیت دارایی «خارج از سرویس» است');
    expect(list.textContent).toContain('مالک این واقعیت: سامانهٔ دارایی');
    expect(list.textContent).toContain('مالک این واقعیت: تعمیر و نگهداری');
    // Every platform block says it cannot be lifted from here.
    for (const item of list.querySelectorAll('li')) {
      expect(item).toHaveAttribute('data-imposed-by', 'PLATFORM');
      expect(item.textContent).toContain('از این صفحه برداشته نمی‌شود');
    }
    // And never shows the service's English sentence.
    expect(list.textContent).not.toMatch(/insurance policy has expired|The machine is in state/);
  });

  it('tells a declaration, an assignment and a platform block apart', () => {
    render(
      <AssetAvailability
        availability={ok(
          machine({
            available: false,
            blockers: [
              { code: 'ACTIVE_ASSIGNMENT', owner: 'fleet-service', detail: 'a' },
              { code: 'DECLARED_UNAVAILABLE', owner: 'fleet-service', detail: 'رزرو' },
            ],
          }),
        )}
        windows={ok(windows([]))}
        now={NOW}
      />,
    );
    const items = [...screen.getByTestId('availability-blockers').querySelectorAll('li')];
    expect(items.map((item) => item.getAttribute('data-imposed-by'))).toEqual([
      'ASSIGNMENT',
      'DECLARATION',
    ]);
  });

  it('says a machine fleet-service has not received yet is not yet known — not free, not blocked', () => {
    render(<AssetAvailability availability={ok(null)} windows={ok(windows([]))} now={NOW} />);
    expect(screen.getByText('وضعیت اعزام هنوز در ناوگان نیامده است')).toBeInTheDocument();
    expect(screen.queryByText('برای اعزام آزاد است')).toBeNull();
  });

  it('shows a blocker it does not know with its code, not hidden', () => {
    render(
      <AssetAvailability
        availability={ok(
          machine({
            available: false,
            blockers: [{ code: 'NEW_THING', owner: 'x-service', detail: 'd' }],
          }),
        )}
        windows={ok(windows([]))}
        now={NOW}
      />,
    );
    expect(screen.getByText('مانع دیگر (NEW_THING)')).toBeInTheDocument();
  });
});

describe('the declarations', () => {
  const states = [
    ['in force', declaration(), 'IN_FORCE', 'در اجرا'],
    [
      'not begun',
      declaration({ fromAt: '2026-11-01T00:00:00.000Z', toAt: null }),
      'SCHEDULED',
      'هنوز آغاز نشده',
    ],
    ['finished', declaration({ toAt: '2026-10-10T00:00:00.000Z' }), 'ENDED', 'پایان‌یافته'],
    ['withdrawn', declaration({ revokedAt: '2026-10-05T00:00:00.000Z' }), 'REVOKED', 'باطل‌شده'],
  ] as const;

  it.each(states)(
    'judges a declaration that is %s against the clock it was handed',
    (_name, window, state, label) => {
      render(
        <AssetAvailability
          availability={ok(machine())}
          windows={ok(windows([window]))}
          now={NOW}
        />,
      );
      const item = screen.getByTestId('availability-windows').querySelector('li')!;
      expect(item).toHaveAttribute('data-state', state);
      expect(within(item).getByText(label)).toBeInTheDocument();
    },
  );

  it('does not use the machine’s clock: a clock far in the future changes nothing', () => {
    jest.useFakeTimers({ now: new Date('2090-01-01T00:00:00Z') });
    try {
      render(
        <AssetAvailability
          availability={ok(machine())}
          windows={ok(windows([declaration()]))}
          now={NOW}
        />,
      );
      expect(screen.getByTestId('availability-windows').querySelector('li')).toHaveAttribute(
        'data-state',
        'IN_FORCE',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows what each says, its period in Solar Hijri, and its reason', () => {
    render(
      <AssetAvailability
        availability={ok(machine())}
        windows={ok(windows([declaration()]))}
        now={NOW}
      />,
    );
    const item = screen.getByTestId('availability-windows').querySelector('li')!;
    expect(within(item).getByText('غیرقابل‌استفاده اعلام شده')).toBeInTheDocument();
    expect(item.textContent).toMatch(/۱۴۰۵/);
    expect(item.textContent).toContain('رزرو برای پروژهٔ راه‌سازی');
  });

  it('says an open-ended declaration lasts until it is withdrawn', () => {
    render(
      <AssetAvailability
        availability={ok(machine())}
        windows={ok(windows([declaration({ toAt: null })]))}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('availability-windows').textContent).toContain('تا ابطال');
  });

  it('says when only the newest are listed', () => {
    render(
      <AssetAvailability
        availability={ok(machine())}
        windows={ok(windows([declaration()], true))}
        now={NOW}
      />,
    );
    expect(screen.getByText(/فقط تازه‌ترین‌ها نشان داده می‌شوند/)).toBeInTheDocument();
  });

  it('says there are none', () => {
    render(<AssetAvailability availability={ok(machine())} windows={ok(windows([]))} now={NOW} />);
    expect(screen.getByText('اعلامی ثبت نشده')).toBeInTheDocument();
  });

  it('shows the reason isolated and without a bidi override (#220)', () => {
    const RLO = String.fromCodePoint(0x202e);
    const { container } = render(
      <AssetAvailability
        availability={ok(machine())}
        windows={ok(windows([declaration({ reason: `رزرو${RLO} پروژه` })]))}
        now={NOW}
      />,
    );
    expect(container.textContent).not.toContain(RLO);
    expect([...container.querySelectorAll('bdi')].map((bdi) => bdi.textContent)).toContain(
      'رزرو پروژه',
    );
  });
});

describe('the one control', () => {
  const all = [
    declaration({ id: 'AVW_FORCE' }),
    declaration({ id: 'AVW_LATER', fromAt: '2026-11-01T00:00:00.000Z', toAt: null }),
    declaration({ id: 'AVW_ENDED', toAt: '2026-10-10T00:00:00.000Z' }),
    declaration({ id: 'AVW_REVOKED', revokedAt: '2026-10-05T00:00:00.000Z' }),
  ];

  it('is drawn beside a declaration in force or not yet begun — and no other', () => {
    const { container } = render(
      <AssetAvailability
        availability={ok(machine())}
        windows={ok(windows(all))}
        now={NOW}
        revoke={REVOKE}
      />,
    );
    const controls = [...container.querySelectorAll('[data-revoke-for]')].map((el) =>
      el.getAttribute('data-revoke-for'),
    );
    expect(controls.sort()).toEqual(['AVW_FORCE', 'AVW_LATER']);
  });

  it('is not drawn at all for a role that may not use it', () => {
    const { container } = render(
      <AssetAvailability availability={ok(machine())} windows={ok(windows(all))} now={NOW} />,
    );
    expect(container.querySelector('button, [type="submit"]')).toBeNull();
  });

  it('is never drawn for a block the platform imposes, whatever the role', () => {
    // Every blocker at once, no declaration: the platform's blocks are not windows,
    // so there is nothing for a control to name.
    const { container } = render(
      <AssetAvailability
        availability={ok(machine({ available: false, blockers: PLATFORM_BLOCKERS }))}
        windows={ok(windows([]))}
        now={NOW}
        revoke={REVOKE}
      />,
    );
    expect(container.querySelector('[data-revoke-for]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(screen.getByText(/از این‌جا قابل ابطال نیستند/)).toBeInTheDocument();
  });

  it('draws the declare form where it was handed', () => {
    render(
      <AssetAvailability
        availability={ok(machine())}
        windows={ok(windows([]))}
        now={NOW}
        declareForm={<form aria-label="اعلام وضعیت دارایی" />}
      />,
    );
    expect(screen.getByRole('form', { name: 'اعلام وضعیت دارایی' })).toBeInTheDocument();
  });
});

describe('when a read does not succeed', () => {
  it.each([
    [{ kind: 'FORBIDDEN' } as const, /اجازهٔ دیدن/],
    [{ kind: 'NOT_FOUND' } as const, /این دارایی پیدا نشد/],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'MALFORMED', correlationId: 'corr-bad' } as const, /corr-bad/],
  ])('says so for %j, on each read, without taking the other down', (failure, expected) => {
    render(
      <AssetAvailability availability={failure} windows={ok(windows([declaration()]))} now={NOW} />,
    );
    expect(screen.getByTestId('availability-windows')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(expected);
    document.body.innerHTML = '';
    render(<AssetAvailability availability={ok(machine())} windows={failure} now={NOW} />);
    expect(screen.getByText('برای اعزام آزاد است')).toBeInTheDocument();
    expect(document.body.textContent).toMatch(expected);
  });
});

describe('the markup', () => {
  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    const { container } = render(
      <AssetAvailability
        availability={ok(machine({ available: false, blockers: PLATFORM_BLOCKERS }))}
        windows={ok(
          windows([
            declaration(),
            declaration({ id: 'AVW_2', revokedAt: '2026-10-05T00:00:00.000Z' }),
          ]),
        )}
        now={NOW}
        revoke={REVOKE}
      />,
    );
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});
