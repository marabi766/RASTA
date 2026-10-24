/**
 * The disposable-broker declaration (PR #378 r5 F2). A broker test that
 * changes the broker beyond topics of its own imports this module FIRST — the
 * create-topics test sets the cluster-wide default `message.max.bytes`, the
 * dead-letter escape test leaves a poison record on `rasta.organization.v1` —
 * and runs only when the environment says the broker is thrown away after the
 * run:
 *
 *   RASTA_DISPOSABLE_BROKER=1 pnpm run test:kafka-limits-broker
 *
 * Anything else — unset, empty, `true`, `0` — stops the process here with a
 * non-zero exit, before the importing file has run a line: no Docker command,
 * no Kafka connection. ES modules run their imports in order, so being the
 * first import is what puts this check ahead of every side effect; the guard
 * test (disposable-broker.test.mjs) runs each file, directly and through its
 * package command, against a recording `docker` and a listening socket.
 *
 * CI declares it only in the broker-authorisation job, whose broker ci-up.sh
 * started for that job alone. Do not put it in `.env` or a bootstrap env
 * file: the package command reads those, and a declaration there would hold
 * for every broker you point it at.
 */
import { basename } from 'node:path';

export const DISPOSABLE_BROKER_DECLARATION = 'RASTA_DISPOSABLE_BROKER';

if (process.env[DISPOSABLE_BROKER_DECLARATION] !== '1') {
  const file = process.argv[1] ? basename(process.argv[1]) : 'this broker test';
  process.stderr.write(
    `${file}: refusing to run — it changes the broker beyond topics of its own ` +
      '(cluster default message.max.bytes, records left on platform topics). ' +
      `Run it only against a broker thrown away afterwards, with ${DISPOSABLE_BROKER_DECLARATION}=1 ` +
      '(CI sets it in the broker-authorisation job alone). Nothing was run.\n',
  );
  process.exit(2);
}
