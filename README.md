<p align="center">
  <img src="assets/rasta-logo.png" alt="RASTA — Intelligent Fleet and Supply Chain Platform" width="720" />
</p>

<h1 align="center">RASTA Platform</h1>

<p align="center">
  A multi-tenant platform for fleet operations, maintenance, supply chains, procurement,
  civil works, financial workflows, and accountable public-sector operations.
</p>

<p align="center">
  <a href="https://github.com/marabi766/RASTA/actions/workflows/ci.yml"><img src="https://github.com/marabi766/RASTA/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node.js 22 or newer" /></a>
  <a href="pnpm-workspace.yaml"><img src="https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white" alt="pnpm 10" /></a>
  <a href="tsconfig.base.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict mode" /></a>
  <img src="https://img.shields.io/badge/license-UNLICENSED-lightgrey" alt="UNLICENSED" />
</p>

> [!IMPORTANT]
> RASTA is under active MVP development. The repository contains production-oriented engineering controls, but it is not
> yet a nationally certified or production-ready system. Payment is simulated behind a provider abstraction; the project
> does not claim a live banking connection, custody of real funds, or absolute security.

## What RASTA is

RASTA is an asset-centric platform designed to connect organizations, operators, suppliers, contractors, and end users
without introducing a mandatory institutional intermediary. Its principal capabilities are:

- electronic asset dossiers, fleet assignment, usage, availability, maintenance, insurance, and inspections;
- a specialist marketplace with catalogue, offers, orders, disputes, and durable Temporal workflows;
- supplier qualification, procurement, inventory, logistics, construction, tender, and contract workflows;
- wallets, an immutable double-entry ledger, simulated payment intents, commissions, rewards, and settlements;
- secure document storage and malware scanning;
- append-only audit evidence, notifications, analytics, and operational observability.

The design is organization-agnostic. No domain identifier or core workflow encodes a particular province, municipality,
village, or organization type. Governance rules, approval authorities, commission rates, and evaluation policies are
configuration—not hard-coded institutional assumptions.

The authoritative product requirements are in `01-طرح-جامع-پلتفرم-رستا.docx`. Architecture decisions and implementation
constraints live in [`docs/`](docs/), while [`AGENTS.md`](AGENTS.md) is the mandatory engineering policy for every human or
automated contributor.

## Current delivery status

The official progress report is generated from [`planning/backlog.json`](planning/backlog.json). Only delivery units that
the product owner has accepted with evidence earn Story Points; code that is implemented, tested, or awaiting acceptance
does not receive partial credit.

| Horizon      | Accepted | Committed | Remaining | Official progress |
| ------------ | -------: | --------: | --------: | ----------------: |
| MVP          |   191 SP |    555 SP |    364 SP |         **34.4%** |
| Full product |   191 SP |    770 SP |    579 SP |         **24.8%** |

These are the official figures as of the generated report dated **2026-09-01**. Several substantial changes have landed or
are under review since that accounting checkpoint—notably Supplier Phase 1 and Audit Service work—but their points remain
unearned until their complete acceptance criteria are satisfied. See
[`docs/25-project-progress.md`](docs/25-project-progress.md) for the auditable calculation and
[`PROJECT_MEMORY.md`](PROJECT_MEMORY.md) for the engineering evidence and known issues.

### Implemented and verified on `main`

| Component              | Port | Current state                                                                                              |
| ---------------------- | ---: | ---------------------------------------------------------------------------------------------------------- |
| `api-gateway`          | 3000 | JWT/JWKS validation, tenant context, authorization, routing, rate limiting, and resilience controls        |
| `identity-service`     | 3101 | Users, memberships, roles, Keycloak synchronization, and service authentication                            |
| `organization-service` | 3102 | Organization hierarchy, inherited policies, and geospatial data                                            |
| `asset-service`        | 3103 | Asset lifecycle, dossier, ownership history, insurance registry, and technical inspections                 |
| `fleet-service`        | 3104 | Drivers, assignments, usage records, and availability                                                      |
| `maintenance-service`  | 3105 | Schedules, requests, repair orders, parts, costs, approval, and settlement events                          |
| `marketplace-service`  | 3106 | Catalogue, offers, orders, reviews, disputes, and Temporal order saga                                      |
| `supplier-service`     | 3108 | Phase 1 qualification foundations are implemented; configurable performance scoring remains incomplete     |
| `economic-service`     | 3112 | Wallet, double-entry ledger, payment abstraction, commission, reward, and settlement workflows             |
| `document-service`     | 3114 | Direct object-storage upload/download, content controls, access policy, and ClamAV scanning                |
| `audit-service`        | 3115 | Domain-event ingestion, append-only storage, tenant-safe reads, and tamper-evident hash-chain verification |
| `notification-service` | 3113 | Buildable service scaffold only; in-app and email delivery are not implemented yet                         |

There is currently **no production frontend under `apps/` on `main`**. The web portal, admin console, PWA behavior, and
offline queue are remaining MVP work. A separate investor-preview branch is not part of the deployable `main` baseline.

### Planned services not yet implemented

`procurement-service` (3107), `inventory-service` (3109), `construction-service` (3110), `contract-service` (3111), and
`analytics-service` (3116) remain planned MVP components. Commercial insurance, IoT/telematics, native mobile applications,
national-system integrations, and a real payment provider belong to conditional or post-MVP scope.

## Architecture

```text
Clients / future Web & Admin applications
                    │ OIDC + JWT
                    ▼
             ┌─────────────┐
             │ API Gateway │
             └──────┬──────┘
                    │ authenticated REST
       ┌────────────┼──────────────────────────────────┐
       ▼            ▼                 ▼                ▼
   identity    organization     domain services    economic
       │            │                 │                │
       └────────────┴────────────┬────┴────────────────┘
                                 │ transactional outbox
                                 ▼
                              Kafka
                         ┌───────┴────────┐
                         ▼                ▼
                    audit/read models  notifications
```

Core architectural invariants:

- **Database ownership per service:** no service reads or writes another service's tables.
- **REST or Kafka only:** cross-service source imports and shared business logic are forbidden.
- **Multi-tenant by default:** every tenant-owned query is scoped by `organizationId`; object-level authorization is tested.
- **Transactional events:** state-changing domain events are published through an outbox and consumed idempotently.
- **Financial integrity:** money uses `bigint` minor units, JSON money values are strings, and ledger journals must balance.
- **Explicit workflows:** long-running operations use Temporal or explicit state machines.
- **Fail-closed security:** endpoints are closed by default and demo behavior never bypasses authentication or isolation.
- **UTC persistence:** calendar conversion, including the Solar Hijri calendar, belongs only to presentation layers.

Start with [`docs/01-executive-architecture.md`](docs/01-executive-architecture.md),
[`docs/04-service-decomposition.md`](docs/04-service-decomposition.md), and the
[`ADR index`](docs/21-adr-list.md).

## Technology stack

| Area                       | Technology                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| Runtime                    | Node.js 22, TypeScript strict mode, NestJS                                     |
| Monorepo                   | pnpm workspaces and Turborepo                                                  |
| APIs and validation        | REST, OpenAPI, Zod                                                             |
| Data                       | PostgreSQL 16, PostGIS, Prisma                                                 |
| Events and workflows       | Kafka, transactional outbox, Temporal                                          |
| Identity                   | Keycloak, OIDC Authorization Code + PKCE, JWT/JWKS                             |
| Files and malware scanning | S3-compatible MinIO, signed URLs, ClamAV                                       |
| Cache and coordination     | Redis                                                                          |
| Observability              | OpenTelemetry, Prometheus, Grafana, structured logs                            |
| Quality and security       | Jest, Supertest, Playwright, Semgrep, Gitleaks, dependency audit, Trivy        |
| Delivery                   | Docker/Compose, GitHub Actions; Kubernetes/Helm is part of remaining hardening |

## Repository layout

```text
rasta/
├── services/               # NestJS gateway and independently owned domain services
├── packages/               # Contracts, configuration, logging, observability, Nest utilities
├── tests/e2e/              # Playwright critical-path scenarios
├── planning/               # Governed backlog and Story Point source of truth
├── infrastructure/         # Docker, Kafka, Keycloak, Prometheus, Grafana, and Kubernetes assets
├── scripts/                # Quality, migration, architecture, and verification gates
├── docs/                   # Architecture, ADRs, API/event references, security, and runbooks
├── docker-compose.yml      # Local development infrastructure
├── AGENTS.md               # Mandatory repository rules
└── PROJECT_MEMORY.md       # Evidence-backed implementation state and engineering history
```

Shared packages may contain types, contracts, schemas, and infrastructure utilities. They must not contain domain business
logic. The repository enforces service boundaries in its quality gates.

## Local development

### Prerequisites

- Node.js 22 or newer
- pnpm 10
- Docker Engine with Docker Compose v2
- Git 2.40 or newer
- approximately 8 GB of free memory and 20 GB of free disk space for the complete local infrastructure

### Bootstrap

```bash
git clone <repository-url> rasta
cd rasta
pnpm install --frozen-lockfile

# PowerShell
Copy-Item .env.example .env

# Bash, macOS, or Linux
cp .env.example .env

pnpm infra:up
pnpm db:generate
pnpm db:migrate
pnpm db:mark-disposable                   # once, for a volume created before the seed marker
RASTA_ALLOW_DEMO_SEED=true pnpm db:seed   # development/test only — see .env.example
pnpm dev
```

`pnpm infra:up` starts the default infrastructure: PostgreSQL/PostGIS, Redis, Kafka, Keycloak, MinIO, Temporal, and ClamAV.
Application services run as Node processes through `pnpm dev`; Compose is intentionally the development infrastructure,
not a complete application deployment.

> [!NOTE]
> `.env.example` defaults PostgreSQL to `127.0.0.1:5433` rather than `localhost`, which can resolve to `::1` first against an
> IPv4-only published port. On Windows, Docker Desktop or an excluded host-port range may prevent that binding; keep the
> address configurable. Repository scripts do not rewrite your `.env`, so an older copy still using `localhost` must be
> updated by hand. `pnpm check:local-postgres-config` validates the checked-in `.env.example`, and
> [`docs/14-testing-strategy.md`](docs/14-testing-strategy.md) § 14.3 contains the `localhost`/IPv6 and Prisma `P2028`
> troubleshooting evidence.

### Optional infrastructure profiles

```bash
docker compose --profile tools up -d          # Kafka UI, Temporal UI, Mailpit
docker compose --profile search up -d         # OpenSearch
docker compose --profile observability up -d  # OpenTelemetry, Prometheus, Grafana
docker compose --profile all up -d             # every optional local component
```

The gateway is available at `http://localhost:3000` after application services start. Implemented services expose liveness
and readiness endpoints; metrics and OpenAPI documents are available where the service currently supports them. Development
credentials in `.env.example` are disposable local values and must never be reused outside local development.

## Development commands

```bash
pnpm dev                    # run current workspaces in watch mode
pnpm build                  # build the complete monorepo
pnpm lint                   # lint every workspace
pnpm typecheck              # strict TypeScript checks
pnpm format:check           # formatting check without rewriting files
pnpm test                   # workspace test phase
pnpm test:unit              # unit tests
pnpm test:integration       # real integration suites; local infrastructure required
NODE_ENV=test E2E_ALLOW_WRITES=true pnpm test:e2e   # Playwright critical paths; complete local stack required
pnpm test:migration         # registered migration reversibility and outbox checks
pnpm progress:check         # ensure the generated progress report matches the backlog
pnpm ci:image-matrix        # require every tracked service Dockerfile in the scan matrix
pnpm verify                 # governed quality chain: progress, architecture, format, lint, types, tests, build
```

Run a single workspace with pnpm filtering:

```bash
pnpm --filter @rasta/audit-service dev
pnpm --filter @rasta/economic-service test:coverage
pnpm exec turbo run build --filter=@rasta/document-service...
```

`pnpm infra:reset` deletes local volumes and data. Use it only when a destructive reset is explicitly intended.

## Testing, security, and CI

Every feature is expected to satisfy the repository's Definition of Done: strict type checking, lint, unit tests,
integration tests for data/event paths, API and event contracts, tenant isolation, authorization, reversible migrations,
build, telemetry, documentation, and an atomic commit. Economic, identity, and construction critical paths also require E2E
coverage.

The CI pipeline includes:

- governed backlog/progress and architecture-boundary checks;
- format, lint, strict type checking, unit tests, build, and independent-test controls;
- real PostgreSQL, Kafka, MinIO, Temporal, Keycloak, and ClamAV integration paths where applicable;
- service coverage gates without lowering thresholds or excluding domain code to obtain a pass;
- tenant isolation, authorization, idempotency, and financial consistency checks;
- Gitleaks, dependency audit, Semgrep, ClamAV freshness validation, and Trivy image scanning;
- a matrix guard that requires every tracked `services/*/Dockerfile` to be built and scanned on pushes to `main`.

Security posture and limitations are documented in
[`docs/09-security-architecture.md`](docs/09-security-architecture.md). Tamper-evident audit hash chains detect modification,
but are not described as tamper-proof without an external trust anchor such as KMS/HSM signing or independently retained
WORM storage.

## Roadmap to MVP

The order below is dependency-aware. Status and acceptance remain governed by the backlog rather than by this summary.

1. **Close active delivery:** finish Supplier configurable performance scoring; finish Audit correction/operability work and
   product acceptance; then implement in-app and email Notification delivery.
2. **Complete the supply chain:** Inventory reservations and stock movements, forward logistics, Procurement demand
   aggregation, RFQ, confidential quotations, evaluation, purchase orders, receipts, and quality control.
3. **Complete commercial domain foundations:** base insurance-claim history, commission business-line policies,
   participation breakdown, and basic user levels.
4. **Deliver construction and contracts:** configurable project approvals, tender publication, encrypted bids,
   multi-criteria evaluation, contracts, statements, split technical/financial approval, and simulated settlement.
5. **Build the production user experience:** web foundation and design system, core domain surfaces, economic/marketplace
   surfaces, supply-chain/construction surfaces, PWA behavior, and an idempotent offline usage queue.
6. **Add analytics and search:** governed read models, baseline-aware economic KPIs, aggregate-only oversight dashboards,
   and tenant-scoped OpenSearch projections.
7. **Harden for staging:** performance/load tests, query review, production-shaped network policy and secrets, complete
   observability, alert ownership, backup plus real restore proof, Helm deployment, and critical security-debt closure.
8. **Run a controlled pilot:** exercise critical flows with real pilot users and data, establish baselines, close operational
   gaps, and make an evidence-based go/no-go decision.

### Planning outlook

The generated progress system intentionally publishes **no official completion forecast** until at least two iterations are
closed. An informal straight-line scenario using the more representative engineering throughput of the most recent delivery
period—approximately 3–4 effective Story Points per calendar day, including substantial work awaiting acceptance—places MVP
completion around **2026-12-14 to 2027-01-13** (approximately **1405/09/23 to 1405/10/23**), with a midpoint near
**1405/10/12**. This is not a commitment. It assumes the recent pace is sustained, product decisions arrive without delay,
parallel work remains safely separable, and integration, frontend, staging, and pilot work do not expose major new
dependencies.

## Beyond MVP: full-product direction

Post-MVP delivery currently represents 215 additional committed Story Points. The planned direction includes:

- commercial insurance quotation, comparison, issuance, claims, and insurer settlement;
- peer-group ranking, transparent participation scoring, campaigns, benefits, and appeal workflows;
- complete reverse logistics covering warranty, repair, replacement, recycling, and disposal;
- telematics device management, GPS, usage, and approved fuel analytics;
- national-scale expansion and conditional extraction of logical domains into independent deployments;
- native mobile applications;
- national-system integrations and digital contract signatures, subject to authority and certificate decisions;
- a real payment provider only after legal, banking, tax, custody, and operational requirements are approved.

The full-product phase must preserve the same service ownership, tenant isolation, financial integrity, configurable
governance, auditability, and security gates used for the MVP. See
[`docs/17-mvp-scope.md`](docs/17-mvp-scope.md) and [`docs/23-risks-and-tradeoffs.md`](docs/23-risks-and-tradeoffs.md).

## Documentation map

| Need                              | Source                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Current evidence and known issues | [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)                                                                                       |
| Product progress and Story Points | [`docs/25-project-progress.md`](docs/25-project-progress.md)                                                                   |
| Executive architecture            | [`docs/01-executive-architecture.md`](docs/01-executive-architecture.md)                                                       |
| Domain and service boundaries     | [`docs/03-domain-model.md`](docs/03-domain-model.md), [`docs/04-service-decomposition.md`](docs/04-service-decomposition.md)   |
| API and event architecture        | [`docs/06-api-architecture.md`](docs/06-api-architecture.md), [`docs/07-event-architecture.md`](docs/07-event-architecture.md) |
| Security and threat model         | [`docs/09-security-architecture.md`](docs/09-security-architecture.md)                                                         |
| Testing strategy                  | [`docs/14-testing-strategy.md`](docs/14-testing-strategy.md)                                                                   |
| MVP and post-MVP scope            | [`docs/17-mvp-scope.md`](docs/17-mvp-scope.md)                                                                                 |
| Architecture decisions            | [`docs/21-adr-list.md`](docs/21-adr-list.md), [`docs/adr/`](docs/adr/)                                                         |
| Open product decisions            | [`docs/24-open-questions.md`](docs/24-open-questions.md)                                                                       |
| Operational runbooks              | [`docs/runbooks/`](docs/runbooks/)                                                                                             |

## Contributing

Read [`AGENTS.md`](AGENTS.md), [`CLAUDE.md`](CLAUDE.md), and the relevant architecture documents before making a change.
Keep each commit atomic and conventional, never bypass hooks, never weaken a passing quality threshold, and never merge a
feature until its applicable CI checks are green. Update contracts, tests, migrations, telemetry, documentation, and the
evidence register in the same change when the Definition of Done requires them.

## License

**UNLICENSED — all rights reserved.** No permission to use, copy, modify, or distribute this repository is granted unless
the rights holder provides it in writing.
