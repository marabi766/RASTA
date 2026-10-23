import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  INVENTORY_CONSIGNEE_NOTE,
  INVENTORY_DONE_MESSAGES,
  INVENTORY_READ_ONLY_NOTE,
  INVENTORY_SHIPMENT_FINISHED_NOTE,
} from '@/lib/inventory-commands';
import type { ReadResult, ShipmentSummary, ShipmentTracking } from '@/server/inventory';

import { ShipmentScreen, type ShipmentScreenProps } from './ShipmentScreen';

/**
 * `/inventory/shipments/[id]`: the shipment, its legs and its tracking, with
 * the dispatch and the delivery for the origin warehouse's operators — every
 * state a viewer can be in. The actions are never reached here
 * (`inventory-actions.spec.ts`, `inventory-retry.spec.tsx`).
 */

jest.mock('../../inventory-actions', () => ({ submitInventoryCommand: jest.fn() }));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const SHIPMENT_ID = `SHP_${ULID}`;
const WAREHOUSE_ID = `WHS_${ULID}`;

const CREATED: ShipmentSummary = {
  id: SHIPMENT_ID,
  organizationId: 'ORG-DEH-0001',
  originWarehouseId: WAREHOUSE_ID,
  consigneeOrganizationId: 'ORG-DEH-0002',
  orderReference: `ORD_${ULID}`,
  status: 'CREATED',
  legs: [
    { sequence: 1, carrierName: 'باربری یک', carrierReference: 'WB-1' },
    { sequence: 2, carrierName: 'باربری دو', carrierReference: null },
  ],
  createdAt: '2026-09-19T08:00:00.000Z',
  dispatchedAt: null,
  deliveredAt: null,
  version: 1,
};
const DISPATCHED: ShipmentSummary = {
  ...CREATED,
  status: 'DISPATCHED',
  dispatchedAt: '2026-09-20T08:00:00.000Z',
  version: 2,
};
const DELIVERED: ShipmentSummary = {
  ...DISPATCHED,
  status: 'DELIVERED',
  deliveredAt: '2026-09-21T08:00:00.000Z',
  version: 3,
};

const TRACKING: ShipmentTracking = {
  shipmentId: SHIPMENT_ID,
  status: 'DISPATCHED',
  events: [
    {
      id: 'T1',
      type: 'CREATED',
      occurredAt: '2026-09-19T08:00:00.000Z',
      recordedAt: '2026-09-19T08:00:00.000Z',
    },
    {
      id: 'T2',
      type: 'DISPATCHED',
      occurredAt: '2026-09-20T08:00:00.000Z',
      recordedAt: '2026-09-20T08:00:00.000Z',
    },
  ],
};

const UNAVAILABLE = { kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-1' } as const;
const MALFORMED = { kind: 'MALFORMED', correlationId: 'corr-1' } as const;
const ok = <T,>(data: T): ReadResult<T> => ({ kind: 'OK', data });

const STAMP = { token: 'stamp', until: Date.now() + 3_000_000 };
const move = (command: 'DISPATCH_SHIPMENT' | 'DELIVER_SHIPMENT') => ({
  command,
  submission: { id: `sub_${command}_KEYKEYKEYKEYKEYKEY`, replay: STAMP },
});

function props(overrides: Partial<ShipmentScreenProps> = {}): ShipmentScreenProps {
  return {
    shipment: ok(CREATED),
    tracking: ok({ ...TRACKING, status: 'CREATED', events: TRACKING.events.slice(0, 1) }),
    offered: [move('DISPATCH_SHIPMENT')],
    canOperate: true,
    consigneeOnly: false,
    csrfToken: 'csrf',
    binding: { owner: 'owner-tag', session: 'session-tag' },
    sessionMaxAgeSeconds: 43_200,
    pageHref: `/inventory/shipments/${SHIPMENT_ID}`,
    ...overrides,
  };
}

describe('the shipment', () => {
  it('shows its status in words, both ends, the order, and the legs in order', () => {
    render(<ShipmentScreen {...props()} />);
    expect(screen.getAllByText('ایجادشده، هنوز ارسال نشده').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: WAREHOUSE_ID })).toHaveAttribute(
      'href',
      `/inventory?warehouse=${WAREHOUSE_ID}`,
    );
    expect(screen.getByText('ORG-DEH-0002')).toBeInTheDocument();
    expect(screen.getByText(`ORD_${ULID}`)).toBeInTheDocument();
    const rows = within(screen.getByRole('table', { name: 'مرحله‌های حمل محموله' })).getAllByRole(
      'row',
    );
    expect(rows[1]).toHaveTextContent('۱');
    expect(rows[1]).toHaveTextContent('باربری یک');
    expect(rows[1]).toHaveTextContent('WB-1');
    expect(rows[2]).toHaveTextContent('باربری دو');
    expect(rows[2]).toHaveTextContent('—');
  });

  it('shows the dates of the steps it has taken', () => {
    render(<ShipmentScreen {...props({ shipment: ok(DELIVERED), offered: [] })} />);
    expect(screen.getByText('زمان ارسال')).toBeInTheDocument();
    expect(screen.getByText('زمان تحویل')).toBeInTheDocument();
  });

  it('shows the tracking events in the order the service gives', () => {
    render(
      <ShipmentScreen
        {...props({ shipment: ok(DISPATCHED), tracking: ok(TRACKING), offered: [] })}
      />,
    );
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('ایجادشده');
    expect(items[1]).toHaveTextContent('ارسال‌شده');
  });

  it('a signed confirmation is shown as success', () => {
    render(<ShipmentScreen {...props({ notice: 'DISPATCH_SHIPMENT' })} />);
    expect(screen.getByText(INVENTORY_DONE_MESSAGES.DISPATCH_SHIPMENT)).toBeInTheDocument();
  });
});

describe('the moves', () => {
  it('a created shipment offers its dispatch only; a dispatched one its delivery only', async () => {
    const { rerender } = render(<ShipmentScreen {...props()} />);
    expect(await screen.findByRole('form', { name: 'ثبت ارسال محموله' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'ثبت تحویل محموله' })).toBeNull();
    // A move has no field of its own: its version rides in the signed stamp.
    expect(
      screen
        .getByRole('form', { name: 'ثبت ارسال محموله' })
        .querySelectorAll('input:not([type=hidden])'),
    ).toHaveLength(0);

    rerender(
      <ShipmentScreen
        {...props({ shipment: ok(DISPATCHED), offered: [move('DELIVER_SHIPMENT')] })}
      />,
    );
    expect(await screen.findByRole('form', { name: 'ثبت تحویل محموله' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'ثبت ارسال محموله' })).toBeNull();
  });

  it('the consignee is told it only reads, and is drawn no form', () => {
    render(<ShipmentScreen {...props({ offered: [], consigneeOnly: true })} />);
    expect(screen.getByText(INVENTORY_CONSIGNEE_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('a reader without the operator role is told so', () => {
    render(<ShipmentScreen {...props({ offered: [], canOperate: false })} />);
    expect(screen.getByText(INVENTORY_READ_ONLY_NOTE)).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('a delivered shipment has nothing left', () => {
    render(<ShipmentScreen {...props({ shipment: ok(DELIVERED), offered: [] })} />);
    expect(screen.getByText(INVENTORY_SHIPMENT_FINISHED_NOTE)).toBeInTheDocument();
  });

  it('an operator of a status the portal does not know is told nothing is needed', () => {
    render(
      <ShipmentScreen {...props({ shipment: ok({ ...CREATED, status: 'LOST' }), offered: [] })} />,
    );
    expect(screen.getByText('در این مرحله اقدامی از سوی شما لازم نیست.')).toBeInTheDocument();
    expect(screen.getByText('LOST')).toBeInTheDocument();
  });
});

describe('what cannot be shown', () => {
  it('a shipment of a stranger and one that does not exist read the same', () => {
    render(<ShipmentScreen {...props({ shipment: { kind: 'NOT_FOUND' }, offered: [] })} />);
    expect(screen.getByText('این محموله پیدا نشد')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('a refusal is no access', () => {
    render(<ShipmentScreen {...props({ shipment: { kind: 'FORBIDDEN' }, offered: [] })} />);
    expect(screen.getByText('محموله‌ها در اختیار نقش شما نیست.')).toBeInTheDocument();
  });

  it.each([UNAVAILABLE, MALFORMED])(
    'a degraded read ($kind) is fixed text and the correlation id',
    (result) => {
      render(<ShipmentScreen {...props({ shipment: result, offered: [] })} />);
      expect(screen.getByText(/این محموله خوانده نشد/)).toBeInTheDocument();
      expect(screen.getByText(/corr-1/)).toBeInTheDocument();
      expect(screen.queryByRole('form')).toBeNull();
    },
  );

  it('a tracking that fails does not take the shipment with it', async () => {
    const { rerender } = render(<ShipmentScreen {...props({ tracking: UNAVAILABLE })} />);
    expect(screen.getByText(/پیگیری محموله خوانده نشد/)).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'ثبت ارسال محموله' })).toBeInTheDocument();
    rerender(<ShipmentScreen {...props({ tracking: { kind: 'FORBIDDEN' } })} />);
    expect(screen.getByText('پیگیری این محموله در اختیار شما نیست.')).toBeInTheDocument();
    rerender(<ShipmentScreen {...props({ tracking: { kind: 'NOT_FOUND' } })} />);
    expect(screen.getByText('پیگیری یافت نشد')).toBeInTheDocument();
    rerender(<ShipmentScreen {...props({ tracking: ok({ ...TRACKING, events: [] }) })} />);
    expect(screen.getByText('رویدادی ثبت نشده')).toBeInTheDocument();
  });

  it('a shipment with no legs says so', () => {
    render(<ShipmentScreen {...props({ shipment: ok({ ...CREATED, legs: [] }), offered: [] })} />);
    expect(screen.getByText('مرحله‌ای ثبت نشده')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  const states: [string, ShipmentScreenProps][] = [
    ['created, dispatch offered', props()],
    [
      'dispatched, delivery offered',
      props({
        shipment: ok(DISPATCHED),
        offered: [move('DELIVER_SHIPMENT')],
        tracking: ok(TRACKING),
      }),
    ],
    ['delivered', props({ shipment: ok(DELIVERED), offered: [] })],
    ['consignee', props({ offered: [], consigneeOnly: true })],
    ['reader without the role', props({ offered: [], canOperate: false })],
    ['confirmed', props({ notice: 'DELIVER_SHIPMENT' })],
    ['not found', props({ shipment: { kind: 'NOT_FOUND' }, offered: [] })],
    ['refused', props({ shipment: { kind: 'FORBIDDEN' }, offered: [] })],
    ['unavailable', props({ shipment: UNAVAILABLE, offered: [] })],
    ['malformed', props({ shipment: MALFORMED, offered: [] })],
    ['tracking unavailable', props({ tracking: UNAVAILABLE })],
    ['tracking empty', props({ tracking: ok({ ...TRACKING, events: [] }) })],
  ];

  it.each(states)('has no violations (%s)', async (_name, state) => {
    const { container } = render(<ShipmentScreen {...state} />);
    if (state.offered.length > 0) await screen.findByRole('form');
    expect(await axe(container)).toHaveNoViolations();
  });
});
