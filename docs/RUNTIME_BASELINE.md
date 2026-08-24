# Runtime Baseline

> Verified runtime and delivery configuration for the current monolithic release line.

This document records the implementation facts that must remain aligned across local development, CI, and production deployment. It is intentionally separate from `ARCHITECTURE.md`, which also contains historical audit decisions and protocol contracts.

## Application runtime

- Node.js: `>=22.13.0` (`package.json` engines)
- Module system: ESM
- Package manager: `pnpm@11.21.0`
- Backend: Express `5.2.1`
- Frontend: React `19.0.1`
- Build: Vite `6.2.3` + esbuild
- Validation: Zod `4.4.3`

## Local commands

Install dependencies with:

```bash
pnpm install --frozen-lockfile
```

Primary commands:

```bash
pnpm run dev
pnpm run lint
pnpm run test:server
pnpm run test:react
pnpm run test:e2e
pnpm run build
```

## Production container

`Dockerfile` uses:

- builder image: `node:22-alpine`
- runtime image: `node:22-alpine`
- pnpm: `11.21.0`
- builder install: `HUSKY=0 pnpm install --frozen-lockfile`
- runtime install: `pnpm install --prod --frozen-lockfile --ignore-scripts`
- runtime user: non-root `nodejs`

## GitHub Actions

`.github/workflows/ci.yml` currently uses:

- Node.js `24`
- pnpm `11.21.0`
- Java `21` for the E2E job

The CI runtime being Node 24 while the application declares Node `>=22.13.0` is intentional: CI verifies the supported engine floor on a newer supported Node release, while production remains pinned to the Node 22 Alpine image.

## Source of truth

When version references disagree, verify against these implementation files first:

1. `package.json` — declared package manager, engine floor, dependencies, and scripts.
2. `Dockerfile` — production container runtime and install policy.
3. `.github/workflows/ci.yml` — CI runtime and dependency installation.

`README.md` and `ARCHITECTURE.md` should describe those facts rather than introduce independent version claims.
