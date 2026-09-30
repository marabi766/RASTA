import { isRetryDelivery, originalDelivery } from './original-delivery';

describe('originalDelivery', () => {
  it('reads <topic>.retry as <topic>, keeping the partition', () => {
    expect(originalDelivery({ topic: 'rasta.notification.v1.retry', partition: 3 })).toEqual({
      topic: 'rasta.notification.v1',
      partition: 3,
    });
  });

  it('returns any other delivery as it is', () => {
    const delivery = Object.freeze({ topic: 'rasta.asset.v1', partition: 0 });
    expect(originalDelivery(delivery)).toBe(delivery);
  });
});

describe('isRetryDelivery', () => {
  it('is true only for a delivery on a .retry topic', () => {
    expect(isRetryDelivery({ topic: 'rasta.asset.v1.retry', partition: 0 })).toBe(true);
    expect(isRetryDelivery({ topic: 'rasta.asset.v1', partition: 0 })).toBe(false);
    expect(isRetryDelivery({ topic: 'rasta.asset.v1.dlq', partition: 0 })).toBe(false);
  });
});
