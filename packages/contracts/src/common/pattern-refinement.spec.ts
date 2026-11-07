import { z } from 'zod';
import {
  patternRefinement,
  publishedRefinementPattern,
  publishablePattern,
} from './pattern-refinement';

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

  it.each(['kind', 'predicate', 'runner', 'when', 'getter'])('refuses a changed %s', (field) => {
    const check = patternRefinement(/^a$/, 'Expected a');
    if (field === 'kind') Object.assign(check._zod.def, { check: 'overwrite' });
    if (field === 'predicate') Object.assign(check._zod.def, { fn: () => true });
    if (field === 'runner')
      check._zod.check = (payload) => {
        payload.value = 'a';
      };
    if (field === 'getter') {
      const fn = Object.getOwnPropertyDescriptor(check._zod.def, 'fn')?.value as unknown;
      Object.defineProperty(check._zod.def, 'fn', { get: () => fn });
    }
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

// FU-181: one conservative policy for refinements, .regex() and datetime zones.
describe('publishablePattern', () => {
  it.each([/^.{1,3}$/, new RegExp('^\\p{L}+$'), /^[^x]{2}$/, new RegExp('^\\a$'), /^[\D]+$/])(
    'omits ambiguous no-flag semantics: %s',
    (pattern) => {
      expect(publishablePattern(pattern)).toBe(false);
    },
  );
  it('keeps literal dots inside a positive BMP character class', () => {
    expect(publishablePattern(/^[a-z0-9_.-]+$/)).toBe(true);
  });
  it.each(['g', 'y', 'gu', 'yu'])(
    'refuses stateful refinement flags %s at construction',
    (flags) => {
      expect(() => patternRefinement(new RegExp('^a$', flags), 'Invalid')).toThrow('Stateful');
    },
  );
});
