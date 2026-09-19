/**
 * The Rasta design system.
 *
 * It lives inside `apps/web` rather than in a `packages/ui` of its own, and
 * `ADR-058` records why: there is one consumer today, `AGENTS.md § 2` says to
 * build in place with a correct internal boundary until there is a second, and
 * the extraction path is written down. This file *is* that boundary — it is
 * the only way into the library, so the day `apps/admin` exists, moving the
 * folder and changing this one import path is the whole extraction.
 *
 * Nothing outside `src/ui` may reach into a component's file directly.
 */

export { cn } from './cn';

export { AppShell } from './layout/AppShell';
export { Grid } from './layout/Grid';
export { PageHeader } from './layout/PageHeader';
export { Section } from './layout/Section';
export { Sidebar } from './layout/Sidebar';
export type { SidebarItem } from './layout/Sidebar';
export { TopBar } from './layout/TopBar';

export { Alert } from './feedback/Alert';
export type { AlertTone } from './feedback/Alert';
export { STATUS_TONES, StatusBadge } from './feedback/StatusBadge';
export type { StatusTone } from './feedback/StatusBadge';

export { EmptyState } from './state/EmptyState';
export { ErrorState } from './state/ErrorState';
export { LoadingState } from './state/LoadingState';
export { NoAccessState } from './state/NoAccessState';
export { Skeleton } from './state/Skeleton';

export { Field, controlClassName } from './form/Field';
export type { FieldControlProps } from './form/Field';
export { Form, useSchemaForm } from './form/Form';
export { MoneyField } from './form/MoneyField';
export { TextField } from './form/TextField';

export { DirectionalIcon } from './text/DirectionalIcon';
export { Identifier } from './text/Identifier';
