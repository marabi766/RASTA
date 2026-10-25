// Preloaded into the real `next build` process (and its workers) by run-web-build.mjs,
// through NODE_OPTIONS. It does not evaluate anything: it watches the configuration Next's
// own loader hands to the build and appends the three layout settings to the capture file
// named by RASTA_BUILD_CAPTURE (one JSON line per call). Nothing is printed.
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload: `--require` loads it before any ESM */
const Module = require('node:module');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');

const capturePath = process.env.RASTA_BUILD_CAPTURE;
const PHASE_PRODUCTION_BUILD = 'phase-production-build';
const CONFIG_MODULE = /[\\/]next[\\/]dist[\\/]server[\\/]config\.js$/;

if (capturePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    let filename;
    try {
      filename = Module._resolveFilename(request, parent, isMain);
    } catch {
      return exported;
    }
    if (!CONFIG_MODULE.test(filename) || typeof exported?.default !== 'function') return exported;
    const loadConfig = exported.default;
    const recording = async (phase, dir, ...rest) => {
      const config = await loadConfig(phase, dir, ...rest);
      if (phase === PHASE_PRODUCTION_BUILD) {
        const record = {
          // The directory Next writes to, as Next computes it: path.join(dir, config.distDir).
          outputDir: join(dir, String(config.distDir)),
          distDir: config.distDir,
          tsconfigPath: config.typescript?.tsconfigPath,
          cleanDistDir: config.cleanDistDir,
        };
        appendFileSync(capturePath, `${JSON.stringify(record)}\n`);
      }
      return config;
    };
    return new Proxy(exported, {
      get: (target, key, receiver) =>
        key === 'default' ? recording : Reflect.get(target, key, receiver),
    });
  };
}
