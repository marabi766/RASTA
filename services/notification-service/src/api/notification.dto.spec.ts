import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@rasta/contracts';
import {
  listNotificationsQuerySchema,
  notificationIdSchema,
  readAllQuerySchema,
  UNREAD_COUNT_CAP,
} from './notification.dto';
import { stateOf, toNotificationView, notificationViewSchema } from './notification.view';
import type { InAppNotification } from '../generated/prisma';

describe('list query', () => {
  it('defaults limit to the platform page size and caps it at the platform maximum', () => {
    expect(listNotificationsQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(MAX_PAGE_SIZE).toBe(200);
    expect(listNotificationsQuerySchema.parse({ limit: '200' }).limit).toBe(200);
    expect(() => listNotificationsQuerySchema.parse({ limit: '201' })).toThrow();
    expect(() => listNotificationsQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => listNotificationsQuerySchema.parse({ limit: 'many' })).toThrow();
  });

  it('accepts the three states and nothing else', () => {
    for (const state of ['UNREAD', 'READ', 'DISMISSED']) {
      expect(listNotificationsQuerySchema.parse({ state }).state).toBe(state);
    }
    expect(() => listNotificationsQuerySchema.parse({ state: 'unread' })).toThrow();
    expect(() => listNotificationsQuerySchema.parse({ state: 'EXPIRED' })).toThrow();
  });

  it('refuses an unknown parameter rather than ignoring it — organizationId above all', () => {
    expect(() => listNotificationsQuerySchema.parse({ organizationId: 'ORG_B' })).toThrow();
    expect(() => listNotificationsQuerySchema.parse({ userId: 'USR_B' })).toThrow();
    expect(() => listNotificationsQuerySchema.parse({ limt: '10' })).toThrow();
    expect(() => readAllQuerySchema.parse({ organizationId: 'ORG_B' })).toThrow();
    expect(readAllQuerySchema.parse({})).toEqual({});
  });

  it('bounds the cursor string before it is ever decoded', () => {
    expect(() => listNotificationsQuerySchema.parse({ cursor: '' })).toThrow();
    expect(() => listNotificationsQuerySchema.parse({ cursor: 'x'.repeat(513) })).toThrow();
  });
});

describe('notification id', () => {
  it('is a prefixed ULID and nothing that could reach a parameter binding unbounded', () => {
    expect(notificationIdSchema.parse('NTN_01J5KX')).toBe('NTN_01J5KX');
    expect(() => notificationIdSchema.parse('')).toThrow();
    expect(() => notificationIdSchema.parse('x'.repeat(65))).toThrow();
    expect(() => notificationIdSchema.parse("NTN_1' OR 1=1")).toThrow();
  });
});

describe('the view', () => {
  const row: InAppNotification = {
    id: 'NTN_1',
    deliveryId: 'NTD_1',
    intentId: 'NTI_1',
    organizationId: 'ORG_A',
    userId: 'USR_A',
    ruleKey: 'insurance.expiring',
    severity: 'WARNING',
    classification: 'ROUTINE',
    subjectType: 'InsurancePolicy',
    subjectId: 'POL_1',
    title: 't',
    body: 'b',
    actionPath: '/assets/AST_1',
    occurredAt: new Date('2026-09-17T06:00:00.000Z'),
    readAt: null,
    dismissedAt: null,
    expiresAt: new Date('2026-11-16T06:00:00.000Z'),
    createdAt: new Date('2026-09-17T06:00:01.000Z'),
  };

  it('derives the state from the timestamps and never stores it', () => {
    expect(stateOf(row)).toBe('UNREAD');
    expect(stateOf({ ...row, readAt: new Date() })).toBe('READ');
    expect(stateOf({ ...row, readAt: new Date(), dismissedAt: new Date() })).toBe('DISMISSED');
  });

  it('publishes neither the owner nor the delivery plumbing, and matches its own schema', () => {
    const view = toNotificationView(row);
    expect(view).not.toHaveProperty('userId');
    expect(view).not.toHaveProperty('organizationId');
    expect(view).not.toHaveProperty('deliveryId');
    expect(view).not.toHaveProperty('intentId');
    expect(notificationViewSchema.parse(view)).toEqual(view);
    expect(view.occurredAt).toBe('2026-09-17T06:00:00.000Z');
    expect(view.state).toBe('UNREAD');
  });

  it('caps the badge at 99', () => {
    expect(UNREAD_COUNT_CAP).toBe(99);
  });
});
