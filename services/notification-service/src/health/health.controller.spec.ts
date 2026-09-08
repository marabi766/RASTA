import { HealthController } from './health.controller';
import { SERVICE_NAME } from '../config/env';

describe('notification-service health probes', () => {
  it('reports the process as live and names itself', () => {
    const live = new HealthController().live();

    expect(live.status).toBe('ok');
    expect(live.service).toBe(SERVICE_NAME);
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an empty dependency set rather than a fabricated one', () => {
    // The assertion that matters. A readiness probe is read during an incident
    // by somebody deciding whether a dependency is at fault, so this service
    // must not answer with a database, broker or relay it never opened. When
    // NTF-001 adds them, this test should fail and be rewritten to assert the
    // real checks — that failure is the point of pinning it here.
    const ready = new HealthController().ready();

    expect(ready.status).toBe('ok');
    expect(ready.service).toBe(SERVICE_NAME);
    expect(ready.dependencies).toEqual({});
    expect(Object.keys(ready.dependencies)).toHaveLength(0);
  });

  it('states in the payload that nothing is implemented and nothing is delivered', () => {
    // A service named `notification` answering a green probe is exactly what
    // somebody could mistake for one that delivers. No email has ever been sent
    // from this platform and no provider has been chosen (ADR-054 § 6, Q-37),
    // so the probe says so in the payload rather than only in a comment.
    const ready = new HealthController().ready();

    expect(ready.implemented).toBe(false);
    expect(ready.deliversMessages).toBe(false);
  });
});
