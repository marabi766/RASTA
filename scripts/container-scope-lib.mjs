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
 *    `turbo.json`, the Prisma copy step, or this workflow itself — affects all;
 *  - anything else (docs, apps, tests, planning, other scripts) affects none.
 *
 * The service list is every directory under `services/` with a Dockerfile,
 * not a hand-kept matrix: three services once went unbuilt and unscanned for
 * releases because a list forgot them.
 */

export const SHARED_INPUTS = [
  /^packages\//,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.dockerignore$/,
  /^\.npmrc$/,
  /^turbo\.json$/,
  /^scripts\/copy-prisma-client\.mjs$/,
  /^\.github\/workflows\/ci\.yml$/,
];

/**
 * @param {string[]} services  services that have a Dockerfile
 * @param {string[] | 'all'} changed  changed paths, or 'all' for a push to main
 * @returns {string[]} services to build, in the order given
 */
export function servicesToBuild(services, changed) {
  if (changed === 'all') return [...services];
  const paths = changed.map((path) => path.trim()).filter((path) => path.length > 0);
  if (paths.some((path) => SHARED_INPUTS.some((pattern) => pattern.test(path)))) {
    return [...services];
  }
  return services.filter((service) =>
    paths.some((path) => path.startsWith(`services/${service}/`)),
  );
}
