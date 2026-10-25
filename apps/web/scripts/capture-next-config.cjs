// Preloaded into the real `next build` process by build-run.mjs (through NODE_OPTIONS) and,
// by this file, into EVERY process the build starts. Nothing is printed.
//
// It does two things, both reported as one JSON line each to the file named by
// RASTA_BUILD_CAPTURE, tagged with the invocation nonce RASTA_BUILD_NONCE:
//
//  1. `config`: the settings of the configuration Next's own loader returned for
//     phase-production-build (the loader's default export is wrapped; nothing is evaluated).
//  2. Completeness. A build config can replace NODE_OPTIONS or delete RASTA_BUILD_CAPTURE
//     before Next starts its workers, which would make them silent. So this file (a) writes a
//     `start` record when it loads in a process or worker thread, (b) wraps every way Node
//     starts a process or a worker thread and puts the preload, the capture path and the nonce
//     into what the child receives, whatever the caller passed (a replaced NODE_OPTIONS keeps
//     its own flags and gains our `--require`), and (c) writes a `spawn` record per child it
//     saw start, saying whether that child is a Node process (which must then report a `start`).
//     build-layout.mjs refuses unless every such child reported. The values used for the
//     records are captured below, when the preload loads, so a later `delete process.env.X` or
//     `process.env.X = ...` by the config cannot change them.
'use strict';
/* global __filename */
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload: `--require` loads it before any ESM */
const childProcess = require('node:child_process');
const Module = require('node:module');
const { appendFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const workerThreads = require('node:worker_threads');

const capturePath = process.env.RASTA_BUILD_CAPTURE;
const nonce = process.env.RASTA_BUILD_NONCE;
const PRELOAD = __filename;
const PRELOAD_FLAG = `--require=${JSON.stringify(PRELOAD)}`;
const PHASE_PRODUCTION_BUILD = 'phase-production-build';
const CONFIG_MODULE = /[\\/]next[\\/]dist[\\/]server[\\/]config\.js$/;

function emit(record) {
  try {
    appendFileSync(
      capturePath,
      `${JSON.stringify({ nonce, pid: process.pid, tid: workerThreads.threadId, ...record })}\n`,
    );
  } catch {
    // A record that cannot be written is a record that is missing: the wrapper refuses.
  }
}

/** The environment a child must get, built from what the caller passed. */
function withCapture(env) {
  const next = { ...(env ?? process.env) };
  const options = String(next.NODE_OPTIONS ?? '');
  next.NODE_OPTIONS = options.includes(PRELOAD) ? options : `${options} ${PRELOAD_FLAG}`.trim();
  next.RASTA_BUILD_CAPTURE = capturePath;
  next.RASTA_BUILD_NONCE = nonce;
  return next;
}

function withCapturePairs(pairs) {
  const env = {};
  for (const pair of pairs ?? []) {
    const at = pair.indexOf('=');
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return Object.entries(withCapture(env)).map(([key, value]) => `${key}=${value}`);
}

const isNodeFile = (file) =>
  file === process.execPath || /^node(js)?(\.exe)?$/i.test(basename(String(file ?? '')));

if (capturePath && nonce) {
  emit({ kind: 'start', ppid: process.ppid });

  // Every asynchronous child (fork, spawn, exec, execFile) goes through here.
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function patchedSpawn(options) {
    const patched = { ...options, envPairs: withCapturePairs(options?.envPairs) };
    const result = originalSpawn.call(this, patched);
    if (typeof this.pid === 'number') {
      emit({ kind: 'spawn', child: this.pid, node: isNodeFile(options?.file) });
    }
    return result;
  };

  // Synchronous children.
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function patchedSpawnSync(file, args, options) {
    const given = Array.isArray(args) ? options : args;
    const patched = { ...given, env: withCapture(given?.env) };
    const result = Array.isArray(args)
      ? originalSpawnSync.call(this, file, args, patched)
      : originalSpawnSync.call(this, file, patched);
    if (typeof result?.pid === 'number' && result.pid > 0) {
      emit({ kind: 'spawn', child: result.pid, node: isNodeFile(file) });
    }
    return result;
  };
  for (const name of ['execSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function patchedExec(file, ...rest) {
      const at = rest.findIndex(
        (arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg),
      );
      if (at >= 0) rest[at] = { ...rest[at], env: withCapture(rest[at].env) };
      else rest.push({ env: withCapture(undefined) });
      return original.call(this, file, ...rest);
    };
  }

  // Worker threads.
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class CapturedWorker extends OriginalWorker {
    constructor(filename, options) {
      const given = options ?? {};
      const env = given.env === workerThreads.SHARE_ENV ? given.env : withCapture(given.env);
      const execArgv = given.execArgv ?? process.execArgv;
      super(filename, {
        ...given,
        env,
        execArgv: execArgv.some((arg) => arg.includes(PRELOAD))
          ? execArgv
          : [...execArgv, '--require', PRELOAD],
      });
      emit({ kind: 'spawn', thread: this.threadId, node: true });
    }
  };

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
        emit({
          kind: 'config',
          // The directory Next writes to, as Next computes it: path.join(dir, config.distDir).
          outputDir: join(dir, String(config.distDir)),
          distDir: config.distDir,
          tsconfigPath: config.typescript?.tsconfigPath,
          cleanDistDir: config.cleanDistDir,
        });
      }
      return config;
    };
    return new Proxy(exported, {
      get: (target, key, receiver) =>
        key === 'default' ? recording : Reflect.get(target, key, receiver),
    });
  };
}
