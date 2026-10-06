import { clearCoverage } from './refusal-coverage';

/** A run starts with no routes seen (the file of the run before is not this run's). */
export default function setup(): void {
  clearCoverage();
}
