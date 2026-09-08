import { HealthController } from './health.controller';
import { SERVICE_NAME } from '../config/env';

describe('audit-service health probes', () => {
  it('reports the process as live and names itself', () => {
    const live = new HealthController().live();

    expect(live.status).toBe('ok');
    expect(live.service).toBe(SERVICE_NAME);
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an empty dependency set rather than a fabricated one', () => {
    // The assertion that matters. A readiness probe is read during an incident
    // by somebody deciding whether a dependency is at fault, so this service
    // must not answer with a database or broker it never opened. When AUD-001
    // adds the schema and the consumer, this test should fail and be rewritten
    // to assert the real checks — that failure is the point of pinning it here.
    const ready = new HealthController().ready();

    expect(ready.status).toBe('ok');
    expect(ready.service).toBe(SERVICE_NAME);
    expect(ready.dependencies).toEqual({});
    expect(Object.keys(ready.dependencies)).toHaveLength(0);
  });

  it('states in the payload that no audit ingestion is implemented', () => {
    // Not decoration. Anything discovering this service by probing it is told
    // plainly that nothing is ingested, stored or queryable, so a green probe
    // cannot be read as a working audit trail (AGENTS.md § 8).
    expect(new HealthController().ready().implemented).toBe(false);
  });
});
