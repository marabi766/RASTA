import { Children, type ReactNode } from 'react';

import { withoutBidiControls } from '@/lib/format';

/**
 * A Latin identifier inside Persian text.
 *
 * docs/16 § 16.3 requires `dir="auto"` for exactly this case, and the reason
 * is visible the moment it is missing. In a right-to-left paragraph, a run
 * such as `ORD-2026-0148` is neutral at its edges, so the bidirectional
 * algorithm attaches the surrounding punctuation to the wrong side: a period
 * after an order code lands in front of it, and a code inside parentheses
 * comes out with the brackets swapped.
 *
 * `<bdi>` is the element for it. It isolates the run so the text around it
 * cannot reorder it and it cannot reorder the text around it, and `dir="auto"`
 * lets the run's own first strong character decide its direction. Writing the
 * attribute out rather than relying on `<bdi>`'s default is deliberate: the
 * rule is the point of the component, and a reader should not have to know the
 * default to see it.
 *
 * The monospace family is the other half of docs/16 § 16.3's font rule —
 * identifiers and codes are read character by character, and a proportional
 * face makes `1`, `l` and `I` harder to tell apart than they need to be.
 *
 * **Monospace is for Latin codes only.** A monospace face has no Persian
 * letters of its own, so the browser falls back glyph by glyph to another font
 * and the joined script comes apart into isolated letters (the licence class
 * «پایه دوم» in the drivers list, demo run 2026-10-24). Whether a value is a
 * code is decided from the value, not from the call site, and fail-closed:
 * the face is applied only when every child is text that is plain printable
 * ASCII after the bidi controls are dropped. Anything else — Persian letters
 * or digits, any other script, an element whose text cannot be inspected —
 * is shown in the surrounding face, still isolated and sanitised.
 */
export function Identifier({ children }: { children: ReactNode }) {
  return (
    <IsolatedText className={isLatinCode(children) ? 'font-mono' : undefined}>
      {children}
    </IsolatedText>
  );
}

/** Printable ASCII only: the characters every monospace face really has. */
const LATIN_CODE = /^[ -~]*$/;

/**
 * True only when the whole of `children` is text that is provably a Latin
 * code: strings and numbers made of printable ASCII, once the bidi controls
 * (which `IsolatedText` drops before display) are removed. An element, a
 * boolean or anything else cannot be inspected, so it is not a code.
 */
function isLatinCode(children: ReactNode): boolean {
  return Children.toArray(children).every(
    (child) =>
      (typeof child === 'string' || typeof child === 'number') &&
      LATIN_CODE.test(withoutBidiControls(String(child))),
  );
}

/**
 * Stored text shown inside Persian text, safely: isolated in its own `<bdi
 * dir="auto">`, and with its bidi controls dropped (L5-06; PR 220).
 *
 * Isolation keeps the run from reordering the text around it; it does not
 * stop an override **inside** the run from reordering the run itself, so a
 * reason or a model stored with U+202E would still read as other words or
 * another number. Every string child goes through `withoutBidiControls`.
 * `Identifier` is this, in the monospace face; free text — a reason, a note,
 * a timeline line — uses it as it is.
 */
export function IsolatedText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="auto" className={className}>
      {Children.map(children, (child) =>
        typeof child === 'string' ? withoutBidiControls(child) : child,
      )}
    </bdi>
  );
}
