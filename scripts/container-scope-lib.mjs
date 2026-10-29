/**
 * Which service images a change must rebuild and scan (L7-35).
 *
 * The image build and Trivy scan used to run only after merge, so a broken or
 * vulnerable image was found on `main`, not on the pull request that caused
 * it. They now run where the merge is decided (owner decision 2026-10-24):
 * on a merge-train run (a pull request whose head is `mq/train-N`) the job
 * builds exactly the images the change can affect, and on a push to `main` it
 * builds every one. An ordinary pull request builds none (see `classifyRun`).
 *
 * Every Dockerfile copies the whole repository into its build stage and then
 * builds one package with its workspace dependencies, so:
 *
 *  - a change under `services/<name>/` affects that service's image;
 *  - a change to anything every build reads — `packages/`, the lockfile, the
 *    workspace and root manifests, TypeScript base config, `.dockerignore`,
 *    `turbo.json`, the Prisma copy step, or the scope scripts — affects all;
 *  - ci.yml affects all unless its parsed workflow settings and both image
 *    jobs are unchanged between the PR base and HEAD (other jobs still gate
 *    containers through its unchanged needs);
 *  - only docs/ and tests/ (excluded by .dockerignore) may affect none;
 *    only the root README.md is re-included; nested READMEs stay excluded.
 *    Manifests/shared inputs always win;
 *  - any unrecognised path affects all (including apps and other scripts).
 *
 * The service list is every directory under `services/` with a Dockerfile,
 * not a hand-kept matrix: three services once went unbuilt and unscanned for
 * releases because a list forgot them.
 */
import { isDeepStrictEqual } from 'node:util';

export const SHARED_INPUTS = [
  /^packages\//,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)pnpm-workspace\.yaml$/,
  /(^|\/)package\.json$/,
  /^tsconfig[^/]*\.json$/,
  /(^|\/)\.dockerignore$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)Dockerfile(?:\.[^/]*)?$/,
  /^turbo\.json$/,
  /^scripts\/copy-prisma-client\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
];

/**
 * Compare YAML values, not hunks or formatting. The existing workspace `yaml`
 * dependency is loaded only for PR workflow analysis: --all needs no install.
 * Missing jobs, ambiguous YAML and any parser failure retain the ALL default.
 */
export async function imageWorkflowUnchanged(baseSource, headSource) {
  let parseDocument;
  try {
    ({ parseDocument } = await import('yaml'));
  } catch {
    warnScopeFallback('YAML parser unavailable');
    return false;
  }
  try {
    const parse = (source) => {
      const document = parseDocument(source, { intAsBigInt: true });
      if (document.errors.length || document.warnings.length) {
        throw new Error('Invalid or ambiguous workflow YAML');
      }
      const workflow = document.toJS({ maxAliasCount: 100 });
      const mapping = (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value);
      if (!mapping(workflow) || !mapping(workflow.jobs)) throw new Error('Missing workflow jobs');
      for (const name of ['containers', 'container-scope']) {
        if (!Object.hasOwn(workflow.jobs, name) || !mapping(workflow.jobs[name])) {
          throw new Error(`Missing image job: ${name}`);
        }
      }
      return workflow;
    };
    const { jobs: baseJobs, ...baseTopLevel } = parse(baseSource);
    const { jobs: headJobs, ...headTopLevel } = parse(headSource);
    return (
      isDeepStrictEqual(baseTopLevel, headTopLevel) &&
      isDeepStrictEqual(baseJobs.containers, headJobs.containers) &&
      isDeepStrictEqual(baseJobs['container-scope'], headJobs['container-scope'])
    );
  } catch {
    // Fixed reasons only: parser errors may contain source text or newlines.
    warnScopeFallback('invalid or ambiguous workflow YAML');
    return false;
  }
}

// Callers supply fixed reasons, never error.message or file contents.
export function warnScopeFallback(reason) {
  process.stderr.write(
    `::warning::Container scope: ${reason}; building and scanning every image.\n`,
  );
}

/**
 * @param {string[]} services  services that have a Dockerfile
 * @param {string[] | 'all'} changed  changed paths, or 'all' for a push to main
 * @param {boolean} workflowUnchanged true only after successful base/HEAD analysis
 * @returns {string[]} services to build, in the order given
 */
export function servicesToBuild(services, changed, workflowUnchanged = false) {
  if (changed === 'all') return [...services];
  const paths = changed.filter(
    (path) => !(workflowUnchanged && path === '.github/workflows/ci.yml'),
  );
  if (paths.some((path) => /^scripts\/container-scope[^/]*\.mjs$/.test(path))) {
    return [...services];
  }
  if (paths.some((path) => SHARED_INPUTS.some((pattern) => pattern.test(path)))) {
    return [...services];
  }
  // .dockerignore excludes these directories (lines 23-24). !README.md
  // matches only the context root, not nested READMEs. Neither scan reads them.
  // No blanket *.md or apps exemption: every Dockerfile does COPY . . .
  const excludedFromImages = (path) => /^(docs|tests)\//.test(path);
  if (
    paths.some(
      (path) =>
        !excludedFromImages(path) &&
        !services.some((service) => path.startsWith(`services/${service}/`)),
    )
  ) {
    return [...services];
  }
  return services.filter((service) =>
    paths.some((path) => path.startsWith(`services/${service}/`)),
  );
}

const hasControlCharacter = (text) =>
  [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

/**
 * Which kind of run this is, from the event alone (never from labels):
 *
 *  - `main`    a push to refs/heads/main: every image;
 *  - `train`   a pull request from this repository whose head is `mq/train-N`
 *              (the PM merge train, which merges only what its run proved):
 *              the affected images, ALL on any classification error;
 *  - `pr`      any other pull request: no image (built on the train);
 *  - `unknown` anything else — another event or branch, missing or malformed
 *              metadata, a fork or malformed name inside the reserved `mq/`
 *              namespace: every image. Unknown never means fewer.
 *
 * Inputs are the workflow's environment (EVENT_NAME, REF, HEAD_REF, HEAD_REPO,
 * REPOSITORY), passed through `env:` and never interpolated into a script: a
 * branch name is attacker-controlled text.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: 'main' | 'train' | 'pr' | 'unknown', reason?: string }}
 */
export function classifyRun(env) {
  const {
    EVENT_NAME: event,
    REF: ref,
    HEAD_REF: head,
    HEAD_REPO: headRepo,
    REPOSITORY: repo,
  } = env;
  if (event === 'push') {
    return ref === 'refs/heads/main'
      ? { mode: 'main' }
      : { mode: 'unknown', reason: 'push to a branch other than main' };
  }
  if (event !== 'pull_request') return { mode: 'unknown', reason: 'unrecognised event' };
  if (!repo || !headRepo || !head || hasControlCharacter(head)) {
    return { mode: 'unknown', reason: 'missing or malformed pull request metadata' };
  }
  if (/^mq\//i.test(head)) {
    return /^mq\/train-[1-9][0-9]*$/.test(head) && headRepo.toLowerCase() === repo.toLowerCase()
      ? { mode: 'train' }
      : {
          mode: 'unknown',
          reason: 'reserved mq/ branch that is not a merge-train branch of this repository',
        };
  }
  return { mode: 'pr' };
}

export const IMAGES_ON_TRAIN_NOTE =
  'Images are built and scanned on the merge train (mq/train-*) and on main, not on ordinary pull requests.';

/**
 * The verdict of the one aggregate check, "Images built and scanned", from
 * the `needs` context of its job (toJSON(needs)). Success only when
 *
 *  - an ordinary pull request selected no image (and says so), or
 *  - every selected image's build and scan job succeeded, or
 *  - a merge-train run selected none, which `servicesToBuild` allows only for
 *    docs/ and tests/ (the reviewed exemption) — the image job must have been
 *    skipped, not failed or cancelled.
 *
 * A skipped, cancelled, failed or missing image job fails a run that selected
 * images, and so does anything unreadable. A required check counts "skipped"
 * as passing, so this job runs always() and decides itself.
 *
 * @returns {{ ok: boolean, message: string }}
 */
export function imagesGateVerdict(needs) {
  const fail = (message) => ({ ok: false, message });
  const scope = needs?.['container-scope'];
  const containers = needs?.containers;
  if (scope?.result !== 'success') {
    return fail(`image selection did not succeed (${String(scope?.result ?? 'missing')})`);
  }
  if (typeof containers?.result !== 'string') return fail('the image job is missing from needs');
  const { mode, services: raw } = scope.outputs ?? {};
  let services;
  try {
    services = JSON.parse(raw);
  } catch {
    return fail('image selection output is not JSON');
  }
  if (!Array.isArray(services) || services.some((name) => typeof name !== 'string' || !name)) {
    return fail('image selection output is malformed');
  }
  const noneBuilt = containers.result === 'skipped';
  if (mode === 'pr') {
    return services.length === 0 && noneBuilt
      ? { ok: true, message: IMAGES_ON_TRAIN_NOTE }
      : fail('an ordinary pull request must select and build no image');
  }
  if (mode !== 'main' && mode !== 'train' && mode !== 'unknown') {
    return fail('image selection mode is missing or unknown');
  }
  if (services.length === 0) {
    return mode === 'train' && noneBuilt
      ? { ok: true, message: 'No image is affected by this change (docs/ and tests/ only).' }
      : fail(`${mode} run selected no image`);
  }
  return containers.result === 'success'
    ? {
        ok: true,
        message: `Built and scanned ${services.length} image(s) (${mode} run): ${services.join(', ')}.`,
      }
    : fail(`the image job ${containers.result} for ${services.length} selected image(s)`);
}
