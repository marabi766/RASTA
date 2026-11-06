import { installWorkflowCoverage } from './temporal-workflow-coverage';

// Loaded by jest.config.js only under `--coverage`.
installWorkflowCoverage();
