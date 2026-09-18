import '@testing-library/jest-dom';
import { toHaveNoViolations } from 'jest-axe';

// docs/16 § 16.9 makes WCAG 2.1 AA a requirement rather than an aspiration.
// Registering the matcher globally means any suite can assert it without
// remembering to wire it up, and a suite that forgets to assert accessibility
// is a review finding rather than a silent pass.
expect.extend(toHaveNoViolations);
