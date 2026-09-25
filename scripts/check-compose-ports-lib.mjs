/**
 * Every port docker-compose.yml publishes must bind to loopback (L7-38).
 *
 * The development stack runs Postgres, Redis, Kafka, MinIO, Keycloak's admin
 * console and more with development credentials or none at all. Published as
 * `'5432:5432'`, Docker binds 0.0.0.0, so anyone on the same network — a café,
 * a shared office, a cloud VM's public interface — reaches them. Each mapping
 * must therefore name its host address: `${COMPOSE_BIND_ADDRESS:-127.0.0.1}`
 * (loopback unless someone deliberately opts out) or a literal `127.0.0.1`.
 *
 * Pure: text in, problems out. Reads the file as text so the check needs
 * neither Docker nor a YAML parser.
 */

export const ALLOWED_HOST_PREFIXES = ['${COMPOSE_BIND_ADDRESS:-127.0.0.1}:', '127.0.0.1:'];

/** @returns {{ errors: string[], checked: number }} */
export function validateComposePorts(text) {
  const errors = [];
  let checked = 0;
  let inPorts = false;
  let portsIndent = 0;

  text.split('\n').forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (/^ports:\s*$/.test(trimmed)) {
      inPorts = true;
      portsIndent = indent;
      return;
    }
    if (!inPorts) return;
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (indent <= portsIndent || !trimmed.startsWith('-')) {
      inPorts = false;
      return;
    }

    const spec = trimmed.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '');
    checked += 1;
    if (!ALLOWED_HOST_PREFIXES.some((prefix) => spec.startsWith(prefix))) {
      errors.push(
        `line ${index + 1}: "${spec}" publishes on every interface; ` +
          `prefix it with ${ALLOWED_HOST_PREFIXES[0]}`,
      );
    }
  });

  return { errors, checked };
}
