import { z } from 'zod';
import { toJsonSchema } from './zod-schema';
import { listNotificationsQuerySchema, notificationIdSchema } from '../api/notification.dto';
import {
  notificationPageSchema,
  notificationViewSchema,
  unreadCountSchema,
} from '../api/notification.view';

/**
 * The bridge between what the service validates with and what it publishes.
 * The failure these guard is not a crash: it is a published document that
 * quietly disagrees with the running service.
 */
describe('the constructs the notification DTOs are built from', () => {
  it('publishes the list query with its bounds, default and enum', () => {
    const schema = toJsonSchema(listNotificationsQuerySchema) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    expect(schema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 25,
    });
    expect(schema.properties.state).toMatchObject({ enum: ['UNREAD', 'READ', 'DISMISSED'] });
    expect(schema.properties.cursor).toMatchObject({ type: 'string' });
    expect(schema.required ?? []).not.toContain('cursor');
  });

  it('publishes the id as a bounded, patterned string', () => {
    expect(toJsonSchema(notificationIdSchema)).toMatchObject({ type: 'string', maxLength: 64 });
  });

  it('publishes the view with its nullable fields and derived state', () => {
    const schema = toJsonSchema(notificationViewSchema) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.state).toMatchObject({ enum: ['UNREAD', 'READ', 'DISMISSED'] });
    expect(JSON.stringify(schema.properties.readAt)).toContain('null');
    expect(schema.required).toEqual(
      expect.arrayContaining(['id', 'state', 'title', 'body', 'createdAt']),
    );
    expect(schema.properties).not.toHaveProperty('userId');
    expect(schema.properties).not.toHaveProperty('organizationId');
  });

  it('publishes a page as an array of views plus a nullable cursor', () => {
    const schema = toJsonSchema(notificationPageSchema) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.items).toMatchObject({ type: 'array' });
    expect(JSON.stringify(schema.properties.nextCursor)).toContain('null');
    expect(schema.properties.hasMore).toMatchObject({ type: 'boolean' });
  });

  it('publishes the unread count with its floor', () => {
    const schema = toJsonSchema(unreadCountSchema) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.count).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schema.properties.capped).toMatchObject({ type: 'boolean' });
  });

  it('describes an unsupported construct as open rather than wrongly', () => {
    expect(toJsonSchema(z.function())).toEqual({});
  });
});
