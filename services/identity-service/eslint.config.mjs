import { nestjs } from '../../eslint.config.mjs';

export default [
  ...nestjs,
  {
    // TEMPORARY, this one file (Q-155): the Keycloak client still sends its
    // client secret and admin bearer with raw fetch on main. PR #483 moves all
    // three exchanges to internalFetch and must delete this block;
    // scripts/internal-token-transport-workspace.test.mjs fails once the file
    // uses internalFetch while the exemption is still here.
    // The transport boundary (`raw-http`) is suspended for the same file and
    // expires with the same block.
    files: ['src/keycloak/keycloak.client.ts'],
    rules: { 'internal/transport': 'off', 'internal/raw-http': 'off' },
  },
];
