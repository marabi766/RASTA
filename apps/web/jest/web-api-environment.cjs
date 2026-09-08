const JSDOMEnvironment = require('jest-environment-jsdom').default;

/**
 * jsdom, plus the Fetch API.
 *
 * jsdom implements the DOM and deliberately not the Fetch standard, so
 * `Response`, `Headers` and `fetch` simply do not exist inside it. Node 22 has
 * all three natively, so the fix is to hand the test realm the ones the
 * platform already provides rather than install a second implementation.
 *
 * This matters for what the tests are worth: `ApiClient` is tested against real
 * `Headers` and real `Response` objects, so an assertion that a header was sent
 * is an assertion about the actual object `fetch` would have received — not
 * about a hand-written stub that agrees with the test by construction.
 */
class WebApiEnvironment extends JSDOMEnvironment {
  constructor(config, context) {
    super(config, context);

    const provided = [
      'fetch',
      'Response',
      'Request',
      'Headers',
      'FormData',
      'Blob',
      'File',
      'ReadableStream',
      'structuredClone',
      'TextEncoder',
      'TextDecoder',
    ];

    for (const name of provided) {
      if (this.global[name] === undefined && globalThis[name] !== undefined) {
        this.global[name] = globalThis[name];
      }
    }
  }
}

module.exports = WebApiEnvironment;
