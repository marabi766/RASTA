/**
 * Every Dockerfile's base image is pinned by digest, and all share one (L7-45).
 *
 * A moving tag (`node:22-alpine`) means two builds of one commit can produce
 * different images, and a base that changed under us is invisible in review.
 * A digest fixes the layer; one digest across every service means an update
 * is one deliberate change the scan then checks everywhere, not twelve that
 * drift apart. `apk upgrade` is refused for the same reason — it pulls
 * whatever the Alpine mirror holds that day. A single named package is the
 * documented stop-gap (docs/runbooks/base-image-update.md) and is allowed.
 *
 * Pure: text in, problems out.
 */

const DIGEST = /@sha256:[0-9a-f]{64}(?=\s|$)/;

/**
 * @param {Array<{ name: string, text: string }>} dockerfiles
 * @returns {{ errors: string[], digests: string[] }}
 */
export function validateDockerfilePins(dockerfiles) {
  const errors = [];
  const digests = new Set();

  for (const { name, text } of dockerfiles) {
    const stages = new Set();
    text.split('\n').forEach((line, index) => {
      const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
      if (from) {
        const [, image, stage] = from;
        if (stage) stages.add(stage);
        if (stages.has(image) && !image.includes(':')) return; // FROM <earlier stage>
        const digest = image.match(DIGEST);
        if (!digest) {
          errors.push(`${name}:${index + 1}: FROM ${image} is not pinned by digest`);
        } else {
          digests.add(`${image.split('@')[0]}${digest[0]}`);
        }
      }
      if (/^\s*RUN\b.*\bapk\b[^\n]*\bupgrade\b\s*(?:&&|;|$)/.test(line)) {
        errors.push(
          `${name}:${index + 1}: \`apk upgrade\` without a package name makes the image unreproducible`,
        );
      }
    });
  }

  if (digests.size > 1) {
    errors.push(`Dockerfiles disagree on the base image digest: ${[...digests].join(', ')}`);
  }
  return { errors, digests: [...digests] };
}
