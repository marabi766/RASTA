import { render } from '@testing-library/react';
import { ReleaseFeedback } from '@/app/ReleaseFeedback';
import { nonStandardSpelling } from '@/test/orthography';
import type { ReleaseReply } from '@/server/unresolved-request-store';
import type { ReleaseOutcome } from '@/server/unresolved-request';
import { RELEASE_MESSAGES, releaseFeedbackKey, type ReleaseFeedbackKey } from './release-messages';

/** A new store answer is a type error here until the table below names it — the exhaustiveness proof. */
const STORE_ANSWERS: Record<ReleaseReply | ReleaseOutcome, true> = {
  RELEASED: true,
  STALE: true,
  GONE: true,
  IN_PROGRESS: true,
  UNAVAILABLE: true,
};
const KEYS = Object.keys(RELEASE_MESSAGES) as ReleaseFeedbackKey[];

describe('FU-217/FU-222 RELEASE_MESSAGES', () => {
  it.each(Object.keys(STORE_ANSWERS))('covers the store answer %s', (answer) => {
    expect(RELEASE_MESSAGES).toHaveProperty(answer);
  });
  it('has one distinct standard-Persian sentence per key, with no Latin letters', () => {
    const texts = KEYS.map((key) => RELEASE_MESSAGES[key]);
    expect(new Set(texts).size).toBe(KEYS.length);
    for (const text of texts) {
      expect(text.trim()).not.toBe('');
      expect(nonStandardSpelling(text)).toBeNull();
      expect(text).not.toMatch(/[A-Za-z]/);
    }
  });
  it.each(['SOMETHING_NEW', '', '__proto__', 'toString', 'constructor', undefined, null, 7])(
    'reads %p as not done, never as a success',
    (unknown) => {
      expect(releaseFeedbackKey(unknown)).toBe('NOT_DONE');
    },
  );
  it.each(KEYS)('ReleaseFeedback renders %s with its own message', (key) => {
    const view = render(<ReleaseFeedback outcome={key} />);
    expect(view.getByRole('alert')).toHaveTextContent(RELEASE_MESSAGES[key]);
  });
  it('renders an unknown outcome as the not-done message and nothing for no outcome', () => {
    const unknown = render(<ReleaseFeedback outcome="SOMETHING_NEW" />);
    expect(unknown.getByRole('alert')).toHaveTextContent(RELEASE_MESSAGES.NOT_DONE);
    unknown.unmount();
    expect(render(<ReleaseFeedback />).container).toBeEmptyDOMElement();
  });
});
