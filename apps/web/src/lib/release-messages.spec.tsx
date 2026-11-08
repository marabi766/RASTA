import { render } from '@testing-library/react';
import { ReleaseFeedback } from '@/app/ReleaseFeedback';
import { nonStandardSpelling } from '@/test/orthography';
import type { ReleaseReply } from '@/server/unresolved-request-store';
import type { ReleaseOutcome } from '@/server/unresolved-request';
import {
  RELEASE_SURFACES,
  RELEASE_TEMPLATES,
  releaseFeedbackKey,
  releaseMessage,
  type ReleaseFeedbackKey,
} from './release-messages';

/** A new store answer is a type error here until the table below names it — the exhaustiveness proof. */
const STORE_ANSWERS: Record<ReleaseReply | ReleaseOutcome, true> = {
  RELEASED: true,
  STALE: true,
  GONE: true,
  IN_PROGRESS: true,
  UNAVAILABLE: true,
};
const KEYS = Object.keys(RELEASE_TEMPLATES) as ReleaseFeedbackKey[];
const CASES = RELEASE_SURFACES.flatMap((surface) => KEYS.map((key) => [surface, key] as const));

describe('FU-217/FU-222/FU-253 release messages', () => {
  it.each(Object.keys(STORE_ANSWERS))('covers the store answer %s', (answer) => {
    expect(RELEASE_TEMPLATES).toHaveProperty(answer);
  });
  it('knows all six surfaces', () => {
    expect([...RELEASE_SURFACES].sort()).toEqual([
      'asset-registration',
      'demand-submission',
      'driver-creation',
      'project-creation',
      'supplier-write',
      'wallet',
    ]);
  });
  it.each(RELEASE_SURFACES)(
    'has one distinct standard-Persian sentence per key on %s, with no Latin letters',
    (surface) => {
      const texts = KEYS.map((key) => releaseMessage(key, surface));
      expect(new Set(texts).size).toBe(KEYS.length);
      for (const text of texts) {
        expect(text.trim()).not.toBe('');
        expect(nonStandardSpelling(text)).toBeNull();
        expect(text).not.toMatch(/[A-Za-z]/);
      }
    },
  );
  it("names the wallet screen's own noun (L2: the money screen says «تراکنش‌ها»)", () => {
    expect(releaseMessage('GONE', 'wallet')).toContain('تراکنش‌ها');
    expect(releaseMessage('IN_PROGRESS', 'wallet')).toContain('تراکنش‌ها');
    expect(releaseMessage('GONE', 'asset-registration')).not.toContain('تراکنش‌ها');
    expect(releaseMessage('GONE', 'asset-registration')).toContain('دارایی‌ها');
    expect(releaseMessage('GONE', 'driver-creation')).toContain('رانندگان');
    expect(releaseMessage('GONE', 'project-creation')).toContain('پروژه‌ها');
    expect(releaseMessage('GONE', 'demand-submission')).toContain('نیازها');
    expect(releaseMessage('GONE', 'supplier-write')).toContain('تأمین‌کنندگان');
  });
  it.each(['SOMETHING_NEW', '', '__proto__', 'toString', 'constructor', undefined, null, 7])(
    'reads %p as not done, never as a success',
    (unknown) => {
      expect(releaseFeedbackKey(unknown)).toBe('NOT_DONE');
      for (const surface of RELEASE_SURFACES) {
        expect(releaseMessage(unknown, surface)).toBe(releaseMessage('NOT_DONE', surface));
      }
    },
  );
  it.each(CASES)('ReleaseFeedback on %s renders %s with its own message', (surface, key) => {
    const view = render(<ReleaseFeedback surface={surface} outcome={key} />);
    expect(view.getByRole('alert')).toHaveTextContent(releaseMessage(key, surface));
  });
  it('renders an unknown outcome as the not-done message and nothing for no outcome', () => {
    const unknown = render(<ReleaseFeedback surface="wallet" outcome="SOMETHING_NEW" />);
    expect(unknown.getByRole('alert')).toHaveTextContent(releaseMessage('NOT_DONE', 'wallet'));
    unknown.unmount();
    expect(render(<ReleaseFeedback surface="wallet" />).container).toBeEmptyDOMElement();
  });
});
