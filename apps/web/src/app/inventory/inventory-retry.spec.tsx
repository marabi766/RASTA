import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

import {
  AMOUNT_FIELD,
  DIRECTION_FIELD,
  PRODUCT_FIELD,
  QUANTITY_FIELD,
  SOURCE_FIELD,
  STOCK_ITEM_FIELD,
  type InventoryScope,
} from '@/lib/inventory-commands';
import {
  answerUnresolvedInventory,
  clearUnresolvedInventory,
  markInventoryOpen,
  purgeAllUnresolvedInventory,
  purgeForeignUnresolvedInventory,
  restoreUnresolvedInventory,
  saveUnresolvedInventory,
  type ReplayStamp,
} from '@/lib/unresolved-inventory';
import { savedAttempt } from '@/test/unresolved-stores';
import { OTHER_PERSON, bindingOf, keyFor } from '@/test/unresolved-binding';

import { InventoryCommandForm } from './InventoryCommandForm';
import { InventoryCommands } from './InventoryCommands';
import {
  afterRetry,
  type InventoryFormState,
  type UnconfirmedInventory,
} from './inventory-form-state';

/**
 * The unconfirmed path with the real `useActionState` — the return retry
 * spec's cases, for the inventory commands; only the action and
 * `/auth/session` are scripted:
 *
 * - a receipt is remembered **before** it is sent, with the body it sends, and a
 *   reload finds it and offers no fresh form for the warehouse (a receipt under
 *   a fresh key moves stock a second time);
 * - the retry posts the same key and the same body;
 * - a call that itself fails is "session ended" only when `/auth/session`
 *   answers `401`; a `503` is not;
 * - at logout, and past the session's lifetime, the entry becomes a marker;
 *   another person's page removes it;
 * - a warehouse's receipt, adjustment and new-shipment forms share one slot: a
 *   lost receipt is never replaced, or cleared, by an adjustment.
 */

const submit = jest.fn<
  Promise<InventoryFormState>,
  [InventoryScope, InventoryFormState, FormData]
>();
jest.mock('./inventory-actions', () => ({
  submitInventoryCommand: (s: InventoryScope, p: InventoryFormState, f: FormData) =>
    submit(s, p, f),
}));

const sessionProbe = jest.fn<Promise<{ status: number }>, [string]>();

const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const WAREHOUSE_ID = `WHS_${ULID}`;
const SHIPMENT_ID = `SHP_${ULID}`;
const ITEM_ID = `SKI_${ULID}`;
const PRODUCT_ID = `PRD_${ULID}`;
const KEY = 'sub_FIRSTKEYFIRSTKEYFIRS';
const FRESH = 'sub_FRESHKEYFRESHKEYFRE';
const OTHER = 'sub_OTHERKEYOTHERKEYOTHE';
const BINDING = bindingOf('owner-tag-A', 'session-tag-1');
const SESSION_MAX_AGE = 12 * 60 * 60;
const WAREHOUSE: InventoryScope = { kind: 'WAREHOUSE', warehouseId: WAREHOUSE_ID };
const SHIPMENT: InventoryScope = { kind: 'SHIPMENT', shipmentId: SHIPMENT_ID };
const WAREHOUSE_SLOT = keyFor('rasta.unresolved-inventory.', BINDING, `warehouse.${WAREHOUSE_ID}`);
const SHIPMENT_SLOT = keyFor('rasta.unresolved-inventory.', BINDING, `shipment.${SHIPMENT_ID}`);
const STAMP: ReplayStamp = { token: 'signed-replay-stamp', until: Date.now() + 50 * 60 * 1000 };
const RECEIPT = { productId: PRODUCT_ID, quantity: 120, sourceReference: null };
const ITEMS = [{ id: ITEM_ID, productId: PRODUCT_ID, onHandQuantity: 120, reservedQuantity: 20 }];
const RETRY_LABEL = 'ارسال دوباره همین درخواست';

const lostResponse = () => new Error('An unexpected response was received from the server.');

function renderReceiptForm() {
  return render(
    <InventoryCommandForm
      scope={WAREHOUSE}
      command="RECEIVE_STOCK"
      csrfToken="csrf"
      submissionId={KEY}
      replay={STAMP}
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      pageHref={`/inventory?warehouse=${WAREHOUSE_ID}`}
    />,
  );
}

/** What the warehouse draws: what a reload brings back. */
function renderWarehouseCommands(keys = { receive: FRESH, adjust: OTHER }) {
  return render(
    <InventoryCommands
      scope={WAREHOUSE}
      offered={[
        { command: 'RECEIVE_STOCK', submission: { id: keys.receive, replay: STAMP } },
        { command: 'ADJUST_STOCK', submission: { id: keys.adjust, replay: STAMP } },
      ]}
      csrfToken="csrf"
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      items={ITEMS}
      pageHref={`/inventory?warehouse=${WAREHOUSE_ID}`}
    />,
  );
}

function fill(container: HTMLElement, quantity = '۱۲۰') {
  fireEvent.change(container.querySelector(`[name="${PRODUCT_FIELD}"]`)!, {
    target: { value: PRODUCT_ID },
  });
  fireEvent.change(container.querySelector(`[name="${QUANTITY_FIELD}"]`)!, {
    target: { value: quantity },
  });
}

async function send(target: HTMLElement | null) {
  await act(async () => {
    fireEvent.submit(target as HTMLElement);
  });
}

const unconfirmedReceipt = (correlationId: string | null = 'COR_ORIGINAL'): InventoryFormState => ({
  kind: 'UNCONFIRMED',
  command: 'RECEIVE_STOCK',
  correlationId,
  submissionId: KEY,
  body: RECEIPT,
  replay: STAMP,
});

function stored(key = WAREHOUSE_SLOT): Record<string, unknown> | null {
  const raw = window.sessionStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  submit.mockReset();
  sessionProbe.mockReset();
  sessionProbe.mockResolvedValue({ status: 204 });
  global.fetch = ((url: string) => sessionProbe(url)) as unknown as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  markInventoryOpen();
});

describe('a receipt sent and not confirmed', () => {
  it('is remembered before it leaves, with the body it sends', async () => {
    let seenWhileSending: Record<string, unknown> | null = null;
    submit.mockImplementation(async () => {
      seenWhileSending = stored();
      return unconfirmedReceipt();
    });
    const { container } = renderReceiptForm();
    fill(container);
    await send(container.querySelector('form'));
    expect(seenWhileSending).toMatchObject({
      submissionId: KEY,
      body: RECEIPT,
      correlationId: null,
    });
    expect(stored()).toMatchObject({
      submissionId: KEY,
      body: RECEIPT,
      correlationId: 'COR_ORIGINAL',
    });
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is checked here first: a quantity of zero is never sent', async () => {
    const { container } = renderReceiptForm();
    fill(container, '0');
    await send(container.querySelector('form'));
    expect(submit).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
    expect(await screen.findByRole('alert')).toHaveTextContent(/عدد صحیح مثبت/);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the retry posts the same key and the same body', async () => {
    submit.mockResolvedValueOnce(unconfirmedReceipt());
    const { container } = renderReceiptForm();
    fill(container);
    await send(container.querySelector('form'));
    submit.mockResolvedValueOnce({
      ...(unconfirmedReceipt() as object),
      retryUnknown: true,
    } as InventoryFormState);
    await send(container.querySelector('form'));
    const retry = submit.mock.calls[1]![2];
    expect(retry.get('submission')).toBe(KEY);
    expect(retry.get('replay')).toBe(STAMP.token);
    expect(retry.get(PRODUCT_FIELD)).toBe(PRODUCT_ID);
    expect(retry.get(QUANTITY_FIELD)).toBe('120');
    expect(retry.get(SOURCE_FIELD)).toBeNull();
  });

  it('a reload finds it, and draws no fresh form over it', async () => {
    saveUnresolvedInventory(
      WAREHOUSE,
      {
        command: 'RECEIVE_STOCK',
        submissionId: KEY,
        body: RECEIPT,
        correlationId: 'COR',
        replay: STAMP,
      },
      BINDING,
    );
    const { container } = renderWarehouseCommands();
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(KEY);
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
    expect(container.querySelector(`input[value="${OTHER}"]`)).toBeNull();
  });

  it('a confirmed answer forgets it', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/x;307;',
    });
    submit.mockRejectedValue(redirect);
    const { container } = renderReceiptForm();
    fill(container);
    await send(container.querySelector('form')).catch(() => undefined);
    await waitFor(() => expect(stored()).toBeNull());
  });

  it('a lost response is "maybe done", not "session ended", unless /auth/session says 401', async () => {
    submit.mockRejectedValue(lostResponse());
    sessionProbe.mockResolvedValue({ status: 503 });
    const first = renderReceiptForm();
    fill(first.container);
    await send(first.container.querySelector('form'));
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(first.container.textContent).not.toContain('نشست شما پایان یافته است');
    first.unmount();
    window.sessionStorage.clear();

    sessionProbe.mockResolvedValue({ status: 401 });
    const second = renderReceiptForm();
    fill(second.container);
    await send(second.container.querySelector('form'));
    expect(await screen.findByText(/نشست شما پایان یافته است/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).not.toBeInTheDocument();
  });

  it('is not sent when it cannot be remembered', async () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const { container } = renderReceiptForm();
    fill(container);
    await send(container.querySelector('form'));
    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByText(/دو بار ثبت شود/)).toBeInTheDocument();
  });
});

describe('a shipment move sent and not confirmed keeps no body', () => {
  it('is remembered with a null body, and the retry posts the same key and stamp', async () => {
    submit.mockResolvedValueOnce({
      kind: 'UNCONFIRMED',
      command: 'DISPATCH_SHIPMENT',
      correlationId: 'COR',
      submissionId: KEY,
      body: null,
      replay: STAMP,
    });
    const { container } = render(
      <InventoryCommandForm
        scope={SHIPMENT}
        command="DISPATCH_SHIPMENT"
        csrfToken="csrf"
        submissionId={KEY}
        replay={STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        pageHref={`/inventory/shipments/${SHIPMENT_ID}`}
      />,
    );
    await send(container.querySelector('form'));
    expect(stored(SHIPMENT_SLOT)).toMatchObject({ command: 'DISPATCH_SHIPMENT', body: null });
    submit.mockResolvedValueOnce({
      kind: 'UNCONFIRMED',
      command: 'DISPATCH_SHIPMENT',
      correlationId: 'COR',
      submissionId: KEY,
      body: null,
      replay: STAMP,
      retryUnknown: true,
    });
    await send(
      await screen.findByRole('button', { name: RETRY_LABEL }).then((b) => b.closest('form')),
    );
    const retry = submit.mock.calls[1]![2];
    expect(retry.get('submission')).toBe(KEY);
    expect(retry.get('replay')).toBe(STAMP.token);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('never silently gone', () => {
  const entry = {
    command: 'RECEIVE_STOCK' as const,
    submissionId: KEY,
    body: RECEIPT,
    correlationId: 'COR',
    replay: STAMP,
  };

  it('at logout an entry becomes a marker: no stamp, no login tag, still blocking', () => {
    saveUnresolvedInventory(WAREHOUSE, entry, BINDING);
    purgeAllUnresolvedInventory();
    markInventoryOpen();
    expect(restoreUnresolvedInventory(WAREHOUSE, BINDING, SESSION_MAX_AGE)).toEqual({
      kind: 'VIEW_ONLY',
      entry: expect.objectContaining({ marker: true, replay: null, body: null, submissionId: KEY }),
    });
    expect(stored()).not.toHaveProperty('session');
    expect(stored()).not.toHaveProperty('body');
  });

  it('past the session’s lifetime it becomes a marker too', () => {
    saveUnresolvedInventory(WAREHOUSE, entry, BINDING, Date.now() - (SESSION_MAX_AGE + 1) * 1000);
    expect(restoreUnresolvedInventory(WAREHOUSE, BINDING, SESSION_MAX_AGE)?.entry.marker).toBe(
      true,
    );
  });

  it('nothing is stored once a logout has started', () => {
    purgeAllUnresolvedInventory();
    expect(saveUnresolvedInventory(WAREHOUSE, entry, BINDING).outcome).toBe('UNAVAILABLE');
  });

  it('from another login it is shown, never re-sent; another person’s page reduces it to a held marker', () => {
    saveUnresolvedInventory(WAREHOUSE, entry, BINDING);
    expect(
      restoreUnresolvedInventory(
        WAREHOUSE,
        { ...BINDING, session: 'session-tag-2' },
        SESSION_MAX_AGE,
      )?.kind,
    ).toBe('VIEW_ONLY');
    purgeForeignUnresolvedInventory({ person: OTHER_PERSON, legacy: [] });
    expect(restoreUnresolvedInventory(WAREHOUSE, BINDING, SESSION_MAX_AGE)).toBeNull();
    // Not removed: a content-free marker that still holds this kind (`lib/unresolved-tenancy.ts`).
    const kept = Object.keys(window.sessionStorage);
    expect(kept).toHaveLength(1);
    expect(JSON.parse(window.sessionStorage.getItem(kept[0]!)!)).toMatchObject({
      quarantined: true,
    });
  });

  it('refuses an entry that is not what its slot holds or is not readable', () => {
    const base = {
      v: 1,
      marker: false,
      scope: `warehouse.${WAREHOUSE_ID}`,
      submissionId: KEY,
      correlationId: null,
      savedAt: Date.now(),
      replay: STAMP,
      owner: BINDING.owner,
      session: BINDING.session,
    };
    for (const value of [
      // A shipment move in a warehouse's slot.
      { command: 'DISPATCH_SHIPMENT', body: null },
    ]) {
      window.sessionStorage.setItem(WAREHOUSE_SLOT, JSON.stringify({ ...base, ...value }));
      expect(restoreUnresolvedInventory(WAREHOUSE, BINDING, SESSION_MAX_AGE)).toBeNull();
      // Left exactly as it is: quarantined, never removed (`lib/unresolved-tenancy.ts`).
      expect(stored()).toMatchObject({ command: 'DISPATCH_SHIPMENT' });
    }
  });

  it('a sent command whose body cannot be read back is held as "outcome unknown", never dropped', () => {
    const base = {
      v: 1,
      marker: false,
      scope: `warehouse.${WAREHOUSE_ID}`,
      submissionId: KEY,
      correlationId: null,
      savedAt: Date.now(),
      replay: STAMP,
      owner: BINDING.owner,
      session: BINDING.session,
    };
    for (const value of [
      { command: 'RECEIVE_STOCK', body: null },
      { command: 'RECEIVE_STOCK', body: { ...RECEIPT, quantity: 0 } },
      { command: 'ADJUST_STOCK', body: RECEIPT },
      { command: 'RECEIVE_STOCK', body: RECEIPT, replay: 'garbage' },
    ]) {
      window.sessionStorage.setItem(WAREHOUSE_SLOT, JSON.stringify({ ...base, ...value }));
      const restored = restoreUnresolvedInventory(WAREHOUSE, BINDING, SESSION_MAX_AGE);
      expect(restored).toMatchObject({
        kind: 'VIEW_ONLY',
        entry: { submissionId: KEY, marker: true, body: null, replay: null },
      });
      // Another submission cannot take the slot while it is held.
      expect(
        saveUnresolvedInventory(
          WAREHOUSE,
          {
            command: 'RECEIVE_STOCK',
            submissionId: OTHER,
            body: RECEIPT,
            correlationId: null,
            replay: STAMP,
          },
          BINDING,
        ).outcome,
      ).toBe('HELD');
    }
  });
});

describe('one unresolved command per warehouse', () => {
  const RECEIVE_KEY = 'sub_RECEIVEKEYRECEIVEKEY';
  const ADJUST_KEY = 'sub_ADJUSTKEYADJUSTKEYADJ';
  const slot = () => stored() as { submissionId: string; command: string } | null;
  const formOf = (name: string) => screen.queryByRole('form', { name });

  it('while the receipt is in doubt, the adjustment form is view-only with the uncertainty notice', async () => {
    // The receipt form is filled so the action is reached.
    const { container } = renderWarehouseCommands({ receive: RECEIVE_KEY, adjust: ADJUST_KEY });
    fill(container);
    submit.mockRejectedValueOnce(lostResponse());
    await send(await screen.findByRole('form', { name: 'ثبت رسید کالا' }));
    await screen.findByRole('button', { name: RETRY_LABEL });
    expect(slot()).toMatchObject({ submissionId: RECEIVE_KEY, command: 'RECEIVE_STOCK' });
    expect(formOf('اصلاح یا خروج مستقیم موجودی')).toBeNull();
    const held = screen.getByRole('region', { name: 'اصلاح یا خروج مستقیم موجودی' });
    expect(held).toHaveTextContent('نتیجه آن هنوز معلوم نیست');
    expect(held.querySelector('button')).toBeNull();
    expect(container.querySelector(`input[value="${ADJUST_KEY}"]`)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an adjustment sent anyway is refused here: nothing sent, the receipt’s record untouched', async () => {
    saveUnresolvedInventory(
      WAREHOUSE,
      {
        command: 'RECEIVE_STOCK',
        submissionId: RECEIVE_KEY,
        body: RECEIPT,
        correlationId: null,
        replay: STAMP,
      },
      BINDING,
    );
    // The adjustment form as it was drawn before the receipt was in doubt.
    const { container } = render(
      <InventoryCommandForm
        scope={WAREHOUSE}
        command="ADJUST_STOCK"
        csrfToken="csrf"
        submissionId={ADJUST_KEY}
        replay={STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        items={ITEMS}
        pageHref="/x"
      />,
    );
    fireEvent.change(container.querySelector(`[name="${STOCK_ITEM_FIELD}"]`)!, {
      target: { value: ITEM_ID },
    });
    fireEvent.change(container.querySelector(`[name="${DIRECTION_FIELD}"]`)!, {
      target: { value: 'DECREASE' },
    });
    fireEvent.change(container.querySelector(`[name="${AMOUNT_FIELD}"]`)!, {
      target: { value: '5' },
    });
    await send(container.querySelector('form'));
    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByText(/نتیجه آن هنوز معلوم نیست/)).toBeInTheDocument();
    expect(slot()).toMatchObject({ submissionId: RECEIVE_KEY, command: 'RECEIVE_STOCK' });
  });

  it('a reload keeps it: only the receipt’s uncertainty view, under its original key', async () => {
    const view = renderWarehouseCommands({ receive: RECEIVE_KEY, adjust: ADJUST_KEY });
    fill(view.container);
    submit.mockRejectedValueOnce(lostResponse());
    await send(await screen.findByRole('form', { name: 'ثبت رسید کالا' }));
    await screen.findByRole('button', { name: RETRY_LABEL });
    view.unmount();
    const { container } = renderWarehouseCommands({
      receive: 'sub_FRESHRECEIVEFRESHRECE',
      adjust: 'sub_FRESHADJUSTFRESHADJU',
    });
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(RECEIVE_KEY);
    expect(formOf('اصلاح یا خروج مستقیم موجودی')).toBeNull();
    expect(container.querySelector('input[value="sub_FRESHADJUSTFRESHADJU"]')).toBeNull();
  });

  it('a definite answer to the receipt’s own first send frees the adjustment form', async () => {
    submit.mockResolvedValueOnce({
      kind: 'INVALID',
      command: 'RECEIVE_STOCK',
      submissionId: RECEIVE_KEY,
      values: null,
      fieldErrors: {},
      message: 'refused',
    });
    const { container } = renderWarehouseCommands({ receive: RECEIVE_KEY, adjust: ADJUST_KEY });
    fill(container);
    await send(await screen.findByRole('form', { name: 'ثبت رسید کالا' }));
    expect(slot()).toBeNull();
    expect(
      await screen.findByRole('form', { name: 'اصلاح یا خروج مستقیم موجودی' }),
    ).toBeInTheDocument();
  });

  it('the slot is never replaced, and cleared only by the submission it belongs to', () => {
    const receipt = {
      command: 'RECEIVE_STOCK' as const,
      submissionId: RECEIVE_KEY,
      body: RECEIPT,
      correlationId: 'COR',
      replay: STAMP,
    };
    expect(saveUnresolvedInventory(WAREHOUSE, receipt, BINDING).outcome).toBe('SAVED');
    expect(
      saveUnresolvedInventory(
        WAREHOUSE,
        {
          ...receipt,
          command: 'ADJUST_STOCK',
          submissionId: ADJUST_KEY,
          body: { stockItemId: ITEM_ID, quantityDelta: -5, sourceReference: null },
        },
        BINDING,
      ).outcome,
    ).toBe('HELD');
    clearUnresolvedInventory(WAREHOUSE, ADJUST_KEY, BINDING);
    expect(slot()).toMatchObject({ submissionId: RECEIVE_KEY, command: 'RECEIVE_STOCK' });
    clearUnresolvedInventory(WAREHOUSE, RECEIVE_KEY, BINDING);
    expect(slot()).toBeNull();
  });

  it('a warehouse’s slot and a shipment’s slot are separate, and a command is never kept in the other', () => {
    saveUnresolvedInventory(
      WAREHOUSE,
      {
        command: 'RECEIVE_STOCK',
        submissionId: KEY,
        body: RECEIPT,
        correlationId: null,
        replay: STAMP,
      },
      BINDING,
    );
    expect(
      saveUnresolvedInventory(
        SHIPMENT,
        {
          command: 'DELIVER_SHIPMENT',
          submissionId: OTHER,
          body: null,
          correlationId: null,
          replay: STAMP,
        },
        BINDING,
      ).outcome,
    ).toBe('SAVED');
    expect(
      saveUnresolvedInventory(
        SHIPMENT,
        {
          command: 'RECEIVE_STOCK',
          submissionId: KEY,
          body: RECEIPT,
          correlationId: null,
          replay: STAMP,
        },
        BINDING,
      ).outcome,
    ).toBe('UNAVAILABLE');
  });
});

/**
 * Found by the live run of `e2e/inventory-commands.spec.ts`: React resets an
 * uncontrolled form once its action has answered, and a `<select>` whose
 * default changed on the way back came back empty, so a corrected second
 * submission posted no item and no direction. A refusal must leave the form as
 * it was typed.
 */
describe('a refused form is drawn again as it was typed', () => {
  const ADJUST_KEY = 'sub_ADJUSTKEYADJUSTKEYADJ';

  it('the selects and the text keep their values, and the corrected submission posts them', async () => {
    submit.mockImplementationOnce(async (_scope, _previous, form) => ({
      kind: 'INVALID',
      command: 'ADJUST_STOCK',
      submissionId: String(form.get('submission')),
      values: {
        [STOCK_ITEM_FIELD]: String(form.get(STOCK_ITEM_FIELD)),
        [DIRECTION_FIELD]: String(form.get(DIRECTION_FIELD)),
        [AMOUNT_FIELD]: String(form.get(AMOUNT_FIELD)),
      },
      fieldErrors: {},
      message: 'refused',
    }));
    submit.mockResolvedValueOnce({ kind: 'IDLE' });
    const { container } = render(
      <InventoryCommandForm
        scope={WAREHOUSE}
        command="ADJUST_STOCK"
        csrfToken="csrf"
        submissionId={ADJUST_KEY}
        replay={STAMP}
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        items={ITEMS}
        pageHref="/x"
      />,
    );
    const field = (name: string) => container.querySelector(`[name="${name}"]`) as HTMLInputElement;
    fireEvent.change(field(STOCK_ITEM_FIELD), { target: { value: ITEM_ID } });
    fireEvent.change(field(DIRECTION_FIELD), { target: { value: 'DECREASE' } });
    fireEvent.change(field(AMOUNT_FIELD), { target: { value: '1000' } });
    await send(container.querySelector('form'));
    await screen.findByText('refused');
    expect(field(STOCK_ITEM_FIELD).value).toBe(ITEM_ID);
    expect(field(DIRECTION_FIELD).value).toBe('DECREASE');
    expect(field(AMOUNT_FIELD).value).toBe('1000');

    fireEvent.change(field(AMOUNT_FIELD), { target: { value: '8' } });
    await send(container.querySelector('form'));
    const second = submit.mock.calls[1]![2];
    expect(second.get(STOCK_ITEM_FIELD)).toBe(ITEM_ID);
    expect(second.get(DIRECTION_FIELD)).toBe('DECREASE');
    expect(second.get(AMOUNT_FIELD)).toBe('8');
    // The same submission id: a refusal frees the service's claim, so the corrected form may reuse it.
    expect(second.get('submission')).toBe(ADJUST_KEY);
  });
});

/**
 * The page is drawn again by a link (another warehouse, the next page of a
 * list) with fresh submission ids and fresh signed stamps, and the same client
 * components stay mounted. A form that kept its `useActionState` would post the
 * id of the earlier render beside the new stamp — a replay refusal — and show
 * the earlier warehouse's values and refusals.
 */
describe('a page drawn again brings fresh forms', () => {
  const SECOND_STAMP: ReplayStamp = {
    token: 'second-signed-stamp',
    until: Date.now() + 50 * 60 * 1000,
  };
  const OTHER_WAREHOUSE: InventoryScope = {
    kind: 'WAREHOUSE',
    warehouseId: 'WHS_01HYYYYYYYYYYYYYYYYYYYYYYY',
  };
  const drawn = (scope: InventoryScope, id: string, stamp: ReplayStamp) => (
    <InventoryCommands
      scope={scope}
      offered={[{ command: 'RECEIVE_STOCK', submission: { id, replay: stamp } }]}
      csrfToken="csrf"
      binding={BINDING}
      sessionMaxAgeSeconds={SESSION_MAX_AGE}
      items={ITEMS}
      pageHref="/inventory"
    />
  );
  const field = (container: HTMLElement, name: string) =>
    container.querySelector(`[name="${name}"]`) as HTMLInputElement;
  const hidden = (container: HTMLElement, name: string) => field(container, name).value;

  it('an invalid form, then pagination: the corrected form posts the new id with the new stamp', async () => {
    const { container, rerender } = render(drawn(WAREHOUSE, KEY, STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    fireEvent.change(field(container, PRODUCT_FIELD), { target: { value: 'cement' } });
    fireEvent.change(field(container, QUANTITY_FIELD), { target: { value: '5' } });
    await send(container.querySelector('form'));
    expect(submit).not.toHaveBeenCalled();
    expect(field(container, PRODUCT_FIELD).value).toBe('cement');
    expect(hidden(container, 'submission')).toBe(KEY);

    // The next page of the same list: same warehouse, a fresh render.
    rerender(drawn(WAREHOUSE, FRESH, SECOND_STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    expect(hidden(container, 'submission')).toBe(FRESH);
    expect(field(container, PRODUCT_FIELD).value).toBe('');

    submit.mockResolvedValueOnce({ kind: 'IDLE' });
    fill(container);
    await send(container.querySelector('form'));
    const form = submit.mock.calls[0]![2];
    expect(form.get('submission')).toBe(FRESH);
    expect(form.get('replay')).toBe(SECOND_STAMP.token);
  });

  it('a refused form, then another warehouse: no stale values, no stale refusal', async () => {
    const { container, rerender } = render(drawn(WAREHOUSE, KEY, STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    fireEvent.change(field(container, PRODUCT_FIELD), { target: { value: 'cement' } });
    await send(container.querySelector('form'));
    await screen
      .findByText(/شناسه کالا را به شکل PRD_/, { selector: '[role="alert"], [role="alert"] *' })
      .catch(() => undefined);
    expect(field(container, PRODUCT_FIELD).value).toBe('cement');

    rerender(drawn(OTHER_WAREHOUSE, FRESH, SECOND_STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    expect(field(container, PRODUCT_FIELD).value).toBe('');
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(hidden(container, 'submission')).toBe(FRESH);
  });

  it('a form refused by the service is clean on the next render', async () => {
    submit.mockResolvedValueOnce({ kind: 'REFUSED', reason: 'REPLAY' });
    const { container, rerender } = render(drawn(WAREHOUSE, KEY, STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    fill(container);
    await send(container.querySelector('form'));
    await screen.findByText(/مهلت این فرم گذشته است/);
    rerender(drawn(OTHER_WAREHOUSE, FRESH, SECOND_STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    expect(screen.queryByText(/مهلت این فرم گذشته است/)).toBeNull();
  });

  it('the answer read for one warehouse is not applied to the next while it is read', async () => {
    saveUnresolvedInventory(
      WAREHOUSE,
      {
        command: 'RECEIVE_STOCK',
        submissionId: KEY,
        body: RECEIPT,
        correlationId: null,
        replay: STAMP,
      },
      BINDING,
    );
    const { rerender } = render(drawn(WAREHOUSE, KEY, STAMP));
    await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    // Another warehouse holds nothing: it draws its own fresh form, not the held one.
    rerender(drawn(OTHER_WAREHOUSE, FRESH, SECOND_STAMP));
    const form = await screen.findByRole('form', { name: 'ثبت رسید کالا' });
    expect(form.querySelector(`[name="submission"]`)).toHaveValue(FRESH);
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('a genuinely unresolved command is still restored, whatever the page now offers', async () => {
    saveUnresolvedInventory(
      WAREHOUSE,
      {
        command: 'RECEIVE_STOCK',
        submissionId: KEY,
        body: RECEIPT,
        correlationId: null,
        replay: STAMP,
      },
      BINDING,
    );
    render(drawn(WAREHOUSE, FRESH, SECOND_STAMP));
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(screen.getByRole('form').querySelector('[name="submission"]')).toHaveValue(KEY);
  });
});

/**
 * Codex PR-363 r2: a page brought back from the browser's history (Back,
 * Forward, the router's cache) draws the props it had — the submission in doubt
 * included — in forms that have lost their state. The matching form came back
 * idle and editable; sent after the replay deadline, its `REPLAY` refusal was
 * taken for the answer to a first send and cleared the record, so the next
 * page offered a fresh key over a receipt that may have committed.
 */
describe('a page brought back from the browser history', () => {
  const RECEIVE_KEY = 'sub_RECEIVEKEYRECEIVEKEY';
  const ADJUST_KEY = 'sub_ADJUSTKEYADJUSTKEYADJ';
  const KEYS = { receive: RECEIVE_KEY, adjust: ADJUST_KEY };
  const ADJUST_LABEL = 'اصلاح یا خروج مستقیم موجودی';
  const FORGET_LABEL = 'وضعیت را دیدم؛ این درخواست را کنار بگذار';
  const VIEW_ONLY_TEXT = /دیگر نمی‌توان\s+همان را با اطمینان دوباره فرستاد/;
  const editable = (container: HTMLElement) =>
    container.querySelector(`input[name="${PRODUCT_FIELD}"]:not([type="hidden"])`);
  const record = () => stored() as { submissionId: string; body: unknown; replay: unknown } | null;

  /** Past the receipt's replay deadline (50 minutes with the portal's defaults). */
  function pastDeadline() {
    const realNow = Date.now.bind(Date);
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 51 * 60 * 1000);
  }

  /** The receipt sent from the warehouse page, its response lost; then the page is left. */
  async function lostReceipt() {
    const view = renderWarehouseCommands(KEYS);
    fill(view.container);
    submit.mockRejectedValueOnce(lostResponse());
    await send(await screen.findByRole('form', { name: 'ثبت رسید کالا' }));
    await screen.findByRole('button', { name: RETRY_LABEL });
    view.unmount();
  }

  it('the form that sent it comes back as its uncertainty view, same key, same body; the others wait', async () => {
    await lostReceipt();
    const { container } = renderWarehouseCommands(KEYS);
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(editable(container)).toBeNull();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(RECEIVE_KEY);
    expect(screen.queryByRole('form', { name: ADJUST_LABEL })).toBeNull();
    expect(screen.getByRole('region', { name: ADJUST_LABEL })).toHaveTextContent(
      'نتیجه آن هنوز معلوم نیست',
    );
    expect(record()).toMatchObject({ submissionId: RECEIVE_KEY, body: RECEIPT });

    submit.mockResolvedValueOnce({
      ...(unconfirmedReceipt() as UnconfirmedInventory),
      submissionId: RECEIVE_KEY,
      retryUnknown: true,
    });
    await send(screen.getByRole('button', { name: RETRY_LABEL }).closest('form'));
    const retry = submit.mock.calls[1]![2];
    expect(submit.mock.calls[1]![1]).toMatchObject({ kind: 'UNCONFIRMED' });
    expect(retry.get('submission')).toBe(RECEIVE_KEY);
    expect(retry.get(PRODUCT_FIELD)).toBe(PRODUCT_ID);
    expect(retry.get(QUANTITY_FIELD)).toBe('120');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('past the replay deadline: view-only, nothing editable, nothing re-sendable, the record kept', async () => {
    await lostReceipt();
    pastDeadline();
    const { container, unmount } = renderWarehouseCommands(KEYS);
    expect(await screen.findByText(VIEW_ONLY_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    expect(editable(container)).toBeNull();
    expect(screen.getByRole('link', { name: FORGET_LABEL })).toBeInTheDocument();
    expect(record()).toMatchObject({ submissionId: RECEIVE_KEY, body: RECEIPT });
    unmount();

    // A fresh page still offers no fresh key over it.
    const fresh = renderWarehouseCommands();
    expect(await screen.findByText(VIEW_ONLY_TEXT)).toBeInTheDocument();
    expect(fresh.container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
    expect(fresh.container.querySelector(`input[value="${OTHER}"]`)).toBeNull();
  });

  it.each([
    ['before the replay deadline', false, { kind: 'IDLE' } as InventoryFormState],
    ['past the replay deadline', true, { kind: 'REFUSED', reason: 'REPLAY' } as InventoryFormState],
  ])(
    'a form drawn with the id in doubt (%s) is never idle: it starts from the record, which it keeps',
    async (_when, expired, answer) => {
      // The form as the earlier `InventoryCommands` drew it on the way back, without
      // `initial`: it restores its own record on mount (`UnresolvedForm`).
      saveUnresolvedInventory(
        WAREHOUSE,
        {
          command: 'RECEIVE_STOCK',
          submissionId: KEY,
          body: RECEIPT,
          correlationId: 'COR_ORIGINAL',
          replay: STAMP,
        },
        BINDING,
      );
      if (expired) pastDeadline();
      submit.mockResolvedValue(answer);
      const { container } = renderReceiptForm();
      expect(await screen.findByText(/کد پیگیری: COR_ORIGINAL/)).toBeInTheDocument();
      // Past the deadline even the kept request is not sent again.
      if (expired) await send(container.querySelector('form'));
      expect(submit).not.toHaveBeenCalled();
      expect(record()).toMatchObject({ submissionId: KEY, body: RECEIPT, replay: STAMP });
      expect(editable(container)).toBeNull();
      expect(await screen.findByText(/کد پیگیری: COR_ORIGINAL/)).toBeInTheDocument();
      if (expired) {
        expect(screen.getByText(VIEW_ONLY_TEXT)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
      } else {
        expect(screen.getByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
      }
    },
  );

  it.each([
    [
      'a passed deadline',
      { kind: 'REFUSED', reason: 'REPLAY' },
      /مهلت ارسال دوباره همین درخواست گذشته است/,
    ],
    ['a 403', { kind: 'FORBIDDEN', correlationId: 'COR_RETRY' }, /ارسال دوباره رد شد/],
    ['a 404', { kind: 'NOT_FOUND' }, /ارسال دوباره رد شد/],
    ['a stale form', { kind: 'REFUSED', reason: 'CSRF' }, /ارسال دوباره رد شد/],
  ] as const)(
    'a retry from the page brought back, refused by %s, keeps the original uncertainty',
    async (_by, refusal, note) => {
      await lostReceipt();
      const { container } = renderWarehouseCommands(KEYS);
      await screen.findByRole('button', { name: RETRY_LABEL });
      // The action's own reading of a refused retry (`submitInventoryCommand`).
      submit.mockImplementationOnce(async (_scope, previous) =>
        afterRetry(previous as UnconfirmedInventory, refusal as InventoryFormState),
      );
      await send(screen.getByRole('button', { name: RETRY_LABEL }).closest('form'));
      expect(await screen.findByText(note)).toBeInTheDocument();
      expect(record()).toMatchObject({ submissionId: RECEIVE_KEY, body: RECEIPT });
      expect(editable(container)).toBeNull();
      expect(screen.queryByRole('form', { name: ADJUST_LABEL })).toBeNull();
    },
  );

  it('the form that sent it, still mounted, keeps its own state when drawn again with the same props', async () => {
    const view = renderWarehouseCommands(KEYS);
    fill(view.container);
    submit.mockRejectedValueOnce(lostResponse());
    await send(await screen.findByRole('form', { name: 'ثبت رسید کالا' }));
    submit.mockResolvedValueOnce({
      ...(unconfirmedReceipt() as UnconfirmedInventory),
      submissionId: RECEIVE_KEY,
      retryUnknown: true,
    });
    await send((await screen.findByRole('button', { name: RETRY_LABEL })).closest('form'));
    const note = /ارسال دوباره نیز نتیجه روشنی نداشت/;
    expect(await screen.findByText(note)).toBeInTheDocument();
    view.rerender(
      <InventoryCommands
        scope={WAREHOUSE}
        offered={[
          { command: 'RECEIVE_STOCK', submission: { id: RECEIVE_KEY, replay: STAMP } },
          { command: 'ADJUST_STOCK', submission: { id: ADJUST_KEY, replay: STAMP } },
        ]}
        csrfToken="csrf"
        binding={BINDING}
        sessionMaxAgeSeconds={SESSION_MAX_AGE}
        items={ITEMS}
        pageHref={`/inventory?warehouse=${WAREHOUSE_ID}`}
      />,
    );
    expect(screen.getByText(note)).toBeInTheDocument();
  });

  it('an id in doubt drawn for another command is not that form: only the record’s own view', async () => {
    saveUnresolvedInventory(
      WAREHOUSE,
      {
        command: 'ADJUST_STOCK',
        submissionId: RECEIVE_KEY,
        body: { stockItemId: ITEM_ID, quantityDelta: -5, sourceReference: null },
        correlationId: null,
        replay: STAMP,
      },
      BINDING,
    );
    const { container } = renderWarehouseCommands(KEYS);
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(screen.getByRole('form', { name: ADJUST_LABEL })).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
    expect(editable(container)).toBeNull();
  });

  it('a first send never takes a slot that holds a record, its own included (UNRESOLVED); an answer still updates it', () => {
    const entry = {
      command: 'RECEIVE_STOCK' as const,
      submissionId: KEY,
      body: RECEIPT,
      correlationId: null,
      replay: STAMP,
    };
    const sent = savedAttempt(saveUnresolvedInventory(WAREHOUSE, entry, BINDING));
    const first = window.sessionStorage.getItem(WAREHOUSE_SLOT);
    expect(
      saveUnresolvedInventory(WAREHOUSE, { ...entry, body: { ...RECEIPT, quantity: 5 } }, BINDING)
        .outcome,
    ).toBe('UNRESOLVED');
    expect(
      saveUnresolvedInventory(WAREHOUSE, { ...entry, submissionId: OTHER }, BINDING).outcome,
    ).toBe('HELD');
    expect(window.sessionStorage.getItem(WAREHOUSE_SLOT)).toBe(first);
    expect(
      answerUnresolvedInventory(WAREHOUSE, { ...entry, correlationId: 'COR' }, BINDING, sent),
    ).toBe('SAVED');
    expect(stored()).toMatchObject({ submissionId: KEY, body: RECEIPT, correlationId: 'COR' });
  });
});

/**
 * Codex PR-363 r3, finding 1, with the real mounted components: with stock 2,
 * an adjustment K / −5 is refused and the service releases K, but the answer
 * is delayed. The page is left and drawn again while it is out; the record
 * brings back K's retry. Another operator receives stock, and the retry of
 * K / −5 commits — its answer lost. The first refusal finally arrives: it must
 * not clear K's record, or the next page offers a fresh key and the same
 * adjustment is applied twice. Only the newest send's own answer may clear.
 */
describe('a late answer of an earlier send (send identities, PR 363 reviews 3 and 4)', () => {
  const RECEIVE_KEY = 'sub_RECEIVEKEYRECEIVEKEY';
  const ADJUST_KEY = 'sub_ADJUSTKEYADJUSTKEYADJ';
  const KEYS = { receive: RECEIVE_KEY, adjust: ADJUST_KEY };
  const ADJUST_LABEL = 'اصلاح یا خروج مستقیم موجودی';
  const ADJUSTMENT = { stockItemId: ITEM_ID, quantityDelta: -5, sourceReference: null };
  const REFUSAL: InventoryFormState = {
    kind: 'INVALID',
    command: 'ADJUST_STOCK',
    submissionId: ADJUST_KEY,
    values: null,
    fieldErrors: {},
    message: 'موجودی منفی می‌شد.',
  };
  const doubt = (correlationId: string): InventoryFormState => ({
    kind: 'UNCONFIRMED',
    command: 'ADJUST_STOCK',
    correlationId,
    submissionId: ADJUST_KEY,
    body: ADJUSTMENT,
    replay: STAMP,
  });
  const redirected = () =>
    Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/x;307;' });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** `act`, for a step after which a confirmed answer's redirect surfaces: that is the navigation. */
  async function actPastRedirect(step: () => Promise<void> | void) {
    try {
      await act(async () => {
        await step();
      });
    } catch (error) {
      if (!String(error).includes('NEXT_REDIRECT')) throw error;
    }
  }

  const IDENTITY = /^[0-9a-f]{32}$/;
  const identity = () => (stored() as { attempt?: unknown } | null)?.attempt;

  /** The adjustment form drawn under K, filled with −5 and sent. */
  async function sendAdjustment() {
    const form = await screen.findByRole('form', { name: ADJUST_LABEL });
    expect(form.querySelector('input[name="submission"]')).toHaveValue(ADJUST_KEY);
    fireEvent.change(form.querySelector(`[name="${STOCK_ITEM_FIELD}"]`)!, {
      target: { value: ITEM_ID },
    });
    fireEvent.change(form.querySelector(`[name="${DIRECTION_FIELD}"]`)!, {
      target: { value: 'DECREASE' },
    });
    fireEvent.change(form.querySelector(`[name="${AMOUNT_FIELD}"]`)!, {
      target: { value: '5' },
    });
    await send(form);
  }

  /** The adjustment K / −5 sent from the warehouse page, its answer still out; then the page is left. */
  async function adjustmentOut() {
    const first = deferred<InventoryFormState>();
    submit.mockImplementationOnce(() => first.promise);
    const view = renderWarehouseCommands(KEYS);
    await sendAdjustment();
    expect(submit).toHaveBeenCalledTimes(1);
    const sent = identity();
    expect(sent).toMatch(IDENTITY);
    expect(stored()).toMatchObject({ submissionId: ADJUST_KEY, body: ADJUSTMENT, attempt: sent });
    view.unmount();
    return { ...first, sent };
  }

  /** The page drawn again: the record brings back K's retry, which is pressed. */
  async function retryAfterRemount(answer: () => Promise<InventoryFormState>) {
    submit.mockImplementationOnce(answer);
    const view = renderWarehouseCommands(KEYS);
    const retry = await screen.findByRole('button', { name: RETRY_LABEL });
    // A confirmed answer redirects: the rejection is the navigation.
    await actPastRedirect(() => {
      fireEvent.click(retry);
    });
    await actPastRedirect(() => undefined);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(String(submit.mock.calls[1]![2].get('submission'))).toBe(ADJUST_KEY);
    return view;
  }

  it("Codex's sequence: the first refusal, arriving after the retry committed unseen, leaves K's record", async () => {
    const first = await adjustmentOut();
    const view = await retryAfterRemount(() => Promise.reject(lostResponse()));
    expect(stored()).toMatchObject({ submissionId: ADJUST_KEY });
    expect(identity()).toMatch(IDENTITY);
    expect(identity()).not.toBe(first.sent);
    const before = window.sessionStorage.getItem(WAREHOUSE_SLOT);

    await act(async () => first.resolve(REFUSAL));
    expect(window.sessionStorage.getItem(WAREHOUSE_SLOT)).toBe(before);
    view.unmount();

    // A reload: only K's uncertainty view, under K, with K's body — no fresh key.
    const { container } = renderWarehouseCommands({ receive: FRESH, adjust: OTHER });
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    expect(container.querySelector('input[name="submission"]')).toHaveValue(ADJUST_KEY);
    expect(container.querySelector(`input[value="${FRESH}"]`)).toBeNull();
    expect(container.querySelector(`input[value="${OTHER}"]`)).toBeNull();
  });

  it("the newest send's own refusal still clears it — a remount alone is not a re-send", async () => {
    const first = await adjustmentOut();
    const view = renderWarehouseCommands(KEYS);
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
    await act(async () => first.resolve(REFUSAL));
    expect(stored()).toBeNull();
    view.unmount();
    renderWarehouseCommands({ receive: FRESH, adjust: OTHER });
    expect(await screen.findByRole('form', { name: ADJUST_LABEL })).toBeInTheDocument();
  });

  it("an earlier send's late answer in doubt does not rewrite the newer send's record", async () => {
    const first = await adjustmentOut();
    await retryAfterRemount(async () => doubt('COR_RETRY'));
    const before = window.sessionStorage.getItem(WAREHOUSE_SLOT);
    // The newer send's own answer in doubt did update it, under its own identity.
    expect(JSON.parse(before!)).toMatchObject({ correlationId: 'COR_RETRY' });
    expect(identity()).not.toBe(first.sent);
    await act(async () => first.resolve(doubt('COR_FIRST')));
    expect(window.sessionStorage.getItem(WAREHOUSE_SLOT)).toBe(before);
  });

  it('after the retry is confirmed, the first send’s late answer in doubt recreates nothing and holds nothing', async () => {
    const first = await adjustmentOut();
    const view = await retryAfterRemount(() => Promise.reject(redirected()));
    expect(stored()).toBeNull();
    await actPastRedirect(() => first.resolve(doubt('COR_FIRST')));
    expect(window.sessionStorage.length).toBe(0);
    view.unmount();
    renderWarehouseCommands({ receive: FRESH, adjust: OTHER });
    expect(await screen.findByRole('form', { name: ADJUST_LABEL })).toBeInTheDocument();
  });

  it('after the person set it aside, the first send’s late answer in doubt is kept aside — never written back as K', async () => {
    const first = await adjustmentOut();
    // The action answers a refused retry with K's view and the note (`afterRetry`).
    await retryAfterRemount(async () => ({
      ...(doubt('COR_FIRST') as UnconfirmedInventory),
      correlationId: null,
      retryRefused: true,
    }));
    expect(stored()).toMatchObject({ submissionId: ADJUST_KEY });
    expect(identity()).not.toBe(first.sent);
    // The person sets it aside — what «وضعیت را دیدم؛ این درخواست را کنار بگذار» calls.
    // (React entangles the two sends' transitions, so the view under it is still
    // drawn as sending until the first send settles.)
    clearUnresolvedInventory(WAREHOUSE, ADJUST_KEY, BINDING);
    expect(stored()).toBeNull();
    await act(async () => first.resolve(doubt('COR_FIRST')));
    expect(stored()).toBeNull();
    const keys = Object.keys(window.sessionStorage);
    expect(keys).toHaveLength(1);
    expect(JSON.parse(window.sessionStorage.getItem(keys[0]!)!)).toMatchObject({
      quarantined: true,
    });
  });

  it('a logout while the first send is out: its late refusal leaves the marker', async () => {
    const first = await adjustmentOut();
    purgeAllUnresolvedInventory();
    markInventoryOpen();
    const marker = window.sessionStorage.getItem(WAREHOUSE_SLOT);
    expect(JSON.parse(marker!)).toMatchObject({ marker: true, submissionId: ADJUST_KEY });
    await act(async () => first.resolve(REFUSAL));
    expect(window.sessionStorage.getItem(WAREHOUSE_SLOT)).toBe(marker);
  });

  it("review 4's sequence: K set aside, made again from the cached page and lost — the first send's late refusal keeps the new record", async () => {
    // 1. K sent; its refusal is delayed. The page is left.
    const first = await adjustmentOut();
    try {
      // 2–3. Back on the page, the person sets K aside — what the link calls; a middle
      // click on it keeps this document, and the first send, alive.
      const back = renderWarehouseCommands(KEYS);
      expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
      clearUnresolvedInventory(WAREHOUSE, ADJUST_KEY, BINDING);
      expect(stored()).toBeNull();
      back.unmount();
      // 4. The cached page still carries K and its stamp: K is sent again as a first
      // send, and this time it commits with its response lost.
      submit.mockRejectedValueOnce(lostResponse());
      const cached = renderWarehouseCommands(KEYS);
      await sendAdjustment();
      expect(submit).toHaveBeenCalledTimes(2);
      expect(String(submit.mock.calls[1]![2].get('submission'))).toBe(ADJUST_KEY);
      // (React entangles this send's transition with the first, still out, so its view
      // is drawn once that settles; the record is written and answered already.)
      const recreated = window.sessionStorage.getItem(WAREHOUSE_SLOT);
      expect(JSON.parse(recreated!)).toMatchObject({ submissionId: ADJUST_KEY, body: ADJUSTMENT });
      expect(identity()).toMatch(IDENTITY);
      expect(identity()).not.toBe(first.sent);

      // 5. The first send's refusal arrives: it says nothing of the new send.
      await act(async () => first.resolve(REFUSAL));
      expect(window.sessionStorage.getItem(WAREHOUSE_SLOT)).toBe(recreated);
      expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
      cached.unmount();

      // A reload: K's uncertainty view, under K — no fresh key over a request that may have committed.
      const { container } = renderWarehouseCommands({ receive: FRESH, adjust: OTHER });
      expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeInTheDocument();
      expect(container.querySelector('input[name="submission"]')).toHaveValue(ADJUST_KEY);
      expect(container.querySelector(`input[value="${OTHER}"]`)).toBeNull();
    } finally {
      // Settled whatever happens, so a failure cannot leave a send out for the next test.
      await act(async () => first.resolve(REFUSAL));
    }
  });

  it('a retry whose identity cannot be recorded is not sent, and K stays as it was', async () => {
    // The first send's answer was lost: K in doubt, nothing out.
    const view = renderWarehouseCommands(KEYS);
    const form = await screen.findByRole('form', { name: ADJUST_LABEL });
    fireEvent.change(form.querySelector(`[name="${STOCK_ITEM_FIELD}"]`)!, {
      target: { value: ITEM_ID },
    });
    fireEvent.change(form.querySelector(`[name="${DIRECTION_FIELD}"]`)!, {
      target: { value: 'DECREASE' },
    });
    fireEvent.change(form.querySelector(`[name="${AMOUNT_FIELD}"]`)!, {
      target: { value: '5' },
    });
    submit.mockRejectedValueOnce(lostResponse());
    await send(form);
    view.unmount();
    const before = window.sessionStorage.getItem(WAREHOUSE_SLOT);
    expect(JSON.parse(before!)).toMatchObject({
      submissionId: ADJUST_KEY,
      attempt: expect.stringMatching(IDENTITY),
    });

    renderWarehouseCommands(KEYS);
    const retry = await screen.findByRole('button', { name: RETRY_LABEL });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
    expect(window.sessionStorage.getItem(WAREHOUSE_SLOT)).toBe(before);
    expect(await screen.findByRole('button', { name: RETRY_LABEL })).toBeEnabled();
  });
});
