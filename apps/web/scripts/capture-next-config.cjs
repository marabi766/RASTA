// Preloaded into the real `next build` process by build-run.mjs (through NODE_OPTIONS) and,
// by this file, into EVERY process the build starts. Nothing is printed, except one fixed
// sentence when the handshake below fails.
//
// It does four things. Each record is one JSON line appended to the file named by
// RASTA_BUILD_CAPTURE, tagged with the invocation nonce RASTA_BUILD_NONCE:
//
//  0. Handshake (the `next build` process only, RASTA_BUILD_ROOT). Before Next runs, wait
//     until the package's build lock names this process's own group (build-lock.mjs); if
//     that does not happen in time, exit having written nothing. A wrapper killed between
//     starting the build and publishing its group therefore leaves no process that writes.
//  1. `config-begin` / `config`: each call of Next's own configuration loader for
//     phase-production-build (the loader's default export is wrapped; nothing is evaluated)
//     is recorded before it starts and, with the settings it returned, when it returns. A
//     call is identified by pid, thread id and a per-thread call number, so a repeated load
//     or a load in a worker thread is a call of its own that must complete.
//  2. Completeness. A build config can replace NODE_OPTIONS or delete RASTA_BUILD_CAPTURE
//     before Next starts its workers, which would make them silent. So this file (a) writes a
//     `start` record when it loads in a process or worker thread, (b) wraps every way Node
//     starts a process or a worker thread and puts the preload and the capture settings into
//     what the child receives, whatever the caller passed (a replaced NODE_OPTIONS keeps its
//     own flags and gains our `--require`), and keeps the child in the build's process group
//     (`detached` is forced off for asynchronous AND synchronous children, so the build lock
//     lives as long as the child and whatever it leaves running), and (c) writes
//     a `spawn` record per child it saw start, saying whether that child is a Node process
//     (which must then report a `start`). build-layout.mjs refuses unless every such child
//     reported and every loader call completed. The values used are captured below, when the
//     preload loads, so a later `delete process.env.X` or `process.env.X = ...` by the config
//     cannot change them.
//  3. A record that cannot be written is FATAL, and visible to the wrapper whatever the build
//     does with errors: the wrapper is sent SIGURG (a kernel signal, not a file that could
//     fail to be written too; ignored by default by any other process) and the whole process
//     group of the build is killed, so `next build` itself dies by a signal even when Next
//     would catch an exception or restart a worker. Throwing in the participant would prove
//     nothing.
'use strict';
/* global __filename */
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload: `--require` loads it before any ESM */
const childProcess = require('node:child_process');
const Module = require('node:module');
const { appendFileSync, readFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const workerThreads = require('node:worker_threads');

const capturePath = process.env.RASTA_BUILD_CAPTURE;
const nonce = process.env.RASTA_BUILD_NONCE;
const wrapperPid = Number(process.env.RASTA_BUILD_WRAPPER) || undefined;
let group = Number(process.env.RASTA_BUILD_GROUP) || undefined;
const PRELOAD = __filename;
const PRELOAD_FLAG = `--require=${JSON.stringify(PRELOAD)}`;
const PHASE_PRODUCTION_BUILD = 'phase-production-build';
const CONFIG_MODULE = /[\\/]next[\\/]dist[\\/]server[\\/]config\.js$/;
const HANDSHAKE_MS = Number(process.env.RASTA_BUILD_HANDSHAKE_MS) || 60_000;
// Only for the `next build` process itself; never passed on (see withCapture).
const ROOT_ONLY = ['RASTA_BUILD_ROOT', 'RASTA_BUILD_OWNER_FILE', 'RASTA_BUILD_HANDSHAKE_MS'];

/** A report that cannot be written ends the whole build, observably (point 3 above). */
function fatal() {
  try {
    if (wrapperPid) process.kill(wrapperPid, 'SIGURG');
  } catch {
    // the wrapper is gone: nobody will certify anything
  }
  try {
    if (group) process.kill(-group, 'SIGKILL');
  } catch {
    // no such group: nothing else to stop
  }
  // Outside a wrapper's build (no group known), or in a worker thread whose process
  // somehow survived: this process ends here.
  process.exit(70);
}

function emit(record) {
  try {
    appendFileSync(
      capturePath,
      `${JSON.stringify({ nonce, pid: process.pid, tid: workerThreads.threadId, ...record })}\n`,
    );
  } catch {
    fatal();
  }
}

/** Handshake (point 0): true once the lock names this process's own group. */
function confirmOwnership(ownerFile) {
  const deadline = Date.now() + HANDSHAKE_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
      // The supervisor is our direct parent and group leader; the reporting root PID
      // is separate. Nothing writes until the lock names that exact supervisor.
      if (
        group &&
        process.ppid === group &&
        owner?.group === group &&
        owner?.pid === wrapperPid &&
        process.kill(-group, 0)
      )
        return true;
    } catch {
      // not published yet, or not ours
    }
    if (Date.now() >= deadline) return false;
    Atomics.wait(pause, 0, 0, 20);
  }
}

/** The environment a child must get, built from what the caller passed. */
function withCapture(env) {
  const next = { ...(env ?? process.env) };
  const options = String(next.NODE_OPTIONS ?? '');
  next.NODE_OPTIONS = options.includes(PRELOAD) ? options : `${options} ${PRELOAD_FLAG}`.trim();
  next.RASTA_BUILD_CAPTURE = capturePath;
  next.RASTA_BUILD_NONCE = nonce;
  for (const [key, value] of [
    ['RASTA_BUILD_WRAPPER', wrapperPid],
    ['RASTA_BUILD_GROUP', group],
  ]) {
    if (value) next[key] = String(value);
    else delete next[key];
  }
  for (const key of ROOT_ONLY) delete next[key];
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

if (capturePath && nonce && process.env.RASTA_BUILD_ROOT === '1' && workerThreads.isMainThread) {
  const ownerFile = process.env.RASTA_BUILD_OWNER_FILE;
  for (const key of ROOT_ONLY) delete process.env[key];
  if (!ownerFile || !confirmOwnership(ownerFile)) {
    process.stderr.write(
      'build: this build does not own the package (lock handshake); nothing was built\n',
    );
    process.exit(1);
  }
}

if (capturePath && nonce) {
  emit({ kind: 'start', ppid: process.ppid });

  // Every asynchronous child (fork, spawn, exec, execFile) goes through here.
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function patchedSpawn(options) {
    const patched = {
      ...options,
      // A detached child would lead a group of its own and outlive the build lock.
      detached: false,
      envPairs: withCapturePairs(options?.envPairs),
    };
    const result = originalSpawn.call(this, patched);
    if (typeof this.pid === 'number') {
      emit({ kind: 'spawn', child: this.pid, node: isNodeFile(options?.file) });
    }
    return result;
  };

  // Synchronous children. `detached` is forced off here too: Node honours it for a
  // synchronous child, and what that child leaves running would be outside the group.
  const isOptions = (arg) => arg !== null && typeof arg === 'object' && !Array.isArray(arg);
  const syncOptions = (given) => ({ ...given, detached: false, env: withCapture(given?.env) });
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function patchedSpawnSync(file, args, options) {
    // spawnSync(file, options) and spawnSync(file, args, options), as Node reads them.
    const argsAreOptions = isOptions(args);
    const patched = syncOptions(argsAreOptions ? args : options);
    const result = originalSpawnSync.call(this, file, argsAreOptions ? [] : args, patched);
    if (typeof result?.pid === 'number' && result.pid > 0) {
      emit({ kind: 'spawn', child: result.pid, node: isNodeFile(file) });
    }
    return result;
  };
  for (const name of ['execSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function patchedExec(file, ...rest) {
      const at = rest.findIndex(isOptions);
      if (at >= 0) rest[at] = syncOptions(rest[at]);
      else {
        // An options slot passed as undefined/null is where Node looks for the options.
        const empty = rest.findIndex((arg, index) => arg == null && index === rest.length - 1);
        if (empty >= 0) rest[empty] = syncOptions(undefined);
        else rest.push(syncOptions(undefined));
      }
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

  let loaderCalls = 0;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments);
    let filename;
    try {
      filename = Module._resolveFilename(request, parent, isMain);
    } catch {
      return exported;
    }
    // Next's CommonJS module export, not a Zod schema method.
    // eslint-disable-next-line zod/no-default
    if (!CONFIG_MODULE.test(filename) || typeof exported?.default !== 'function') return exported;
    // eslint-disable-next-line zod/no-default -- Next's configuration loader default export
    const loadConfig = exported.default;
    const recording = async (phase, dir, ...rest) => {
      if (phase !== PHASE_PRODUCTION_BUILD) return loadConfig(phase, dir, ...rest);
      loaderCalls += 1;
      const call = loaderCalls;
      // Before the load: a call that began and never reported its result is refused.
      emit({ kind: 'config-begin', call });
      const config = await loadConfig(phase, dir, ...rest);
      emit({
        kind: 'config',
        call,
        // The directory Next writes to, as Next computes it: path.join(dir, config.distDir).
        outputDir: join(dir, String(config.distDir)),
        distDir: config.distDir,
        tsconfigPath: config.typescript?.tsconfigPath,
        cleanDistDir: config.cleanDistDir,
      });
      return config;
    };
    return new Proxy(exported, {
      get: (target, key, receiver) =>
        key === 'default' ? recording : Reflect.get(target, key, receiver),
    });
  };
}
