import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'node:util';

/**
 * jsdom ships neither `TextDecoder` nor `structuredClone`, and Radix's
 * `Select` needs three layout APIs jsdom does not implement at all. Providing
 * them here rather than mocking Radix keeps the component tests exercising the
 * real primitive — including its keyboard and ARIA behaviour, which is the
 * reason the primitive was chosen.
 */

if (typeof globalThis.TextDecoder === 'undefined') {
  Object.assign(globalThis, { TextDecoder, TextEncoder });
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
