import { RETRY_TOPIC_SUFFIX, ownerTopicOf } from '@rasta/contracts';
import type { EventDelivery } from './event-consumer';

/**
 * The delivery as if it had arrived on the topic that owns the event. A replay
 * on `<topic>.retry` is the same event as on `<topic>`; consumers that key on
 * the delivery topic (audit's projections, notification's source topic) must
 * not see the retry twin as a different topic. Other deliveries are returned
 * as they are.
 */
export function originalDelivery(delivery: EventDelivery): EventDelivery {
  const topic = ownerTopicOf(delivery.topic);
  return topic === delivery.topic ? delivery : Object.freeze({ ...delivery, topic });
}

/**
 * Whether the broker delivered this on `<topic>.retry`, i.e. it is a replay.
 *
 * `<topic>` and `<topic>.retry` are separate streams, so a replayed event can
 * arrive after newer ones: a consumer that keeps STATE must not apply its
 * payload but refresh from the owner of that state (D-039). Read from the
 * delivery topic the broker reported, never from the envelope.
 */
export function isRetryDelivery(delivery: EventDelivery): boolean {
  return delivery.topic.endsWith(RETRY_TOPIC_SUFFIX);
}
