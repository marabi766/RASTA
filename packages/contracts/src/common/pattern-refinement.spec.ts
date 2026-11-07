import { z } from 'zod';
import { patternRefinement, publishedRefinementPattern } from './pattern-refinement';

describe('pattern refinement registry', () => {
  it('registers a value-preserving refine with the legacy custom issue', () => {
    const check = patternRefinement(/^a$/u, 'Expected a');
    const schema = z.string().check(check);
    expect(schema.parse('a')).toBe('a');
    expect(schema.safeParse('b').error?.issues).toMatchObject([
      { code: 'custom', message: 'Expected a' },
    ]);
    expect(publishedRefinementPattern(check)).toEqual({ source: '^a$', flags: 'u' });
  });

  it('refuses an arbitrary refine, a mutating check and a copied check', () => {
    const registered = patternRefinement(/^a$/, 'Expected a');
    for (const check of [
      z.refine<string>(() => true),
      z.check<string>((payload) => {
        payload.value = 'a';
      }),
      { ...registered },
    ]) {
      Object.defineProperty(check, Symbol.for('rasta.openapi.publishedPattern'), { value: /^a$/ });
      expect(publishedRefinementPattern(check)).toBeUndefined();
    }
  });

  it.each(['kind', 'predicate', 'runner', 'when'])('refuses a changed %s', (field) => {
    const check = patternRefinement(/^a$/, 'Expected a');
    if (field === 'kind') Object.assign(check._zod.def, { check: 'overwrite' });
    if (field === 'predicate') Object.assign(check._zod.def, { fn: () => true });
    if (field === 'runner')
      check._zod.check = (payload) => {
        payload.value = 'a';
      };
    if (field === 'when') Object.assign(check._zod.def, { when: () => true });
    expect(publishedRefinementPattern(check)).toBeUndefined();
  });

  it('does not expose its owned regex through the lookup', () => {
    const check = patternRefinement(/^a$/, 'Expected a');
    const published = publishedRefinementPattern(check);
    Object.assign(published!, { source: '.*', flags: 'i' });
    expect(publishedRefinementPattern(check)).toEqual({ source: '^a$', flags: '' });
    expect(z.string().check(check).safeParse('b').success).toBe(false);
  });
});
