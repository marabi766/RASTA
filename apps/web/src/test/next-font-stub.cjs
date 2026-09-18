// `next/font/google` is a build-time transform, not a runtime module: the Next
// compiler rewrites the call into a reference to files it has already fetched
// and emitted. Under Jest there is no such compiler, so the import resolves
// here instead.
//
// The stub returns the same shape the real loader does, with a stable class
// name, so a component that spreads `vazirmatn.variable` onto an element
// renders something deterministic and a snapshot does not churn on a font
// hash. Nothing in the suite asserts the typeface itself — that is a question
// for the browser, not for jsdom.
const loader = () => ({
  className: 'font-vazirmatn',
  variable: 'font-vazirmatn-variable',
  style: { fontFamily: 'Vazirmatn' },
});

module.exports = new Proxy(
  {},
  {
    get: () => loader,
  },
);
