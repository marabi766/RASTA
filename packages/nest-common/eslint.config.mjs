// This package houses the shared NestJS guards, filters and interceptors, so
// it uses dependency injection like a service does. `Reflector` and the auth
// options token are constructor parameter types *and* injection tokens, and
// rewriting them to `import type` would elide the binding and break DI at
// runtime. See the `nestjs` export in the root config for the full reasoning.
export { nestjs as default } from '../../eslint.config.mjs';
