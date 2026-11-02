import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test as guardedTest } from './expect.ts';
import { repositoryRoot } from './kafka-observer.ts';

/**
 * The guard on Playwright's own `expect` (#452), run under `node --test`
 * without a stack: a hazardous absence check fails on a run where it would
 * pass; everything else is Playwright's answer.
 */

const LUCKY = JSON.stringify({ timestamp: '2026-10-25T01:39:13.000Z' });

describe('the e2e expect', () => {
  it('test.expect is the guarded expect in both harnesses', async () => {
    // Load by URL at runtime: the portal harness belongs to a separate TypeScript project.
    // From the repository root, whichever directory the runner starts in.
    const portal = pathToFileURL(join(repositoryRoot(), 'apps/web/e2e/expect.ts')).href;
    const { expect: portalExpect, test: portalTest } = await import(portal);
    assert.equal(guardedTest.expect, expect);
    assert.equal(portalTest.expect, portalExpect);
    for (const guarded of [guardedTest.expect, portalTest.expect]) {
      assert.throws(() => guarded(LUCKY).not.toContain('12.5'), /can fail by chance/);
    }
  });
  it('refuses an absence check a generated value could fail, whatever this run holds', () => {
    assert.equal(LUCKY.includes('12.5'), false);
    assert.throws(() => expect(LUCKY).not.toContain('12.5'), /can fail by chance/);
    assert.throws(
      () => expect(JSON.stringify({ id: '01JABCDEFGHJKMNPQRSTVWXYZ0' })).not.toMatch(/attempt/i),
      /inside the generated ulid/,
    );
  });

  it('leaves every other toContain and toMatch to Playwright', () => {
    expect(LUCKY).not.toContain('482139.5');
    expect(LUCKY).toContain('13.000');
    expect(LUCKY).toMatch(/T01:39/);
    expect(['12.5']).toContain('12.5');
    expect(['01JABCDEFGHJKMNPQRSTVWXYZ0']).not.toContain('12.5');
    assert.throws(() => expect('price 482139.5').not.toContain('482139.5'), /toContain/);
    assert.throws(() => expect(LUCKY).toContain('nothing'), /toContain/);
    assert.throws(() => expect(['a']).not.toContain('a'), /toContain/);
  });
});
