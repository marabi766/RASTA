/**
 * Which service images a change must rebuild and scan (L7-35).
 *
 * The image build and Trivy scan used to run only after merge, so a broken or
 * vulnerable image was found on `main`, not on the pull request that caused
 * it. On a pull request the job now builds exactly the images the change can
 * affect; on a push to `main` it builds every one, as before.
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
