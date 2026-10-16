import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// The backlog declares planning/backlog.schema.json as its contract, so that
// file is enforced as written, by a real Draft 2020-12 validator. The semantic
// rules in progress-lib.mjs (point totals, dependencies, cycles, approvals)
// cannot be expressed in JSON Schema and run alongside it; neither replaces
// the other. Before this existed, nothing enforced `additionalProperties`, and
// the committed backlog had drifted from its own schema unnoticed.
export function compileBacklogSchema(schema) {
  // Strict mode stays on, so an unknown keyword or format in the schema is an
  // error rather than silently ignored. strictRequired is Ajv's own lint (not
  // the specification) and rejects the conditional `then: { required: [...] }`
  // on change-log entries, whose properties are declared one level up.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

function describe(error) {
  const where = error.instancePath === '' ? '/' : error.instancePath;
  if (error.keyword === 'additionalProperties') {
    return `schema: ${where} has unexpected property '${error.params.additionalProperty}'`;
  }
  return `schema: ${where} ${error.message}`;
}

export function validateBacklogSchema(backlog, schema) {
  const validate = compileBacklogSchema(schema);
  return validate(backlog) ? [] : validate.errors.map(describe);
}
