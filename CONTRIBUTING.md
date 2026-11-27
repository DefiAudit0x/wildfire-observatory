# Contributing

Thank you for helping improve the project.

## Before opening an issue

Search existing issues first. For bugs, include expected behavior, actual behavior, reproduction steps, environment, and relevant logs with secrets removed. For security issues, use `SECURITY.md` instead of a public issue.

## Development setup

Requirements: Node.js 22.13.0 or newer and pnpm 11.21.0 (the version declared in `package.json`).

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run lint
pnpm run test:server
pnpm run test:react
pnpm run build
```

Run end-to-end tests only when Chromium and the required local environment are available:

```bash
pnpm exec playwright install chromium
pnpm run test:e2e
```

## Pull requests

Keep each PR focused. Explain the problem, the design decision, security or privacy implications, and the tests you ran. Do not commit credentials, production data, generated build artifacts, or private reports.

For changes that affect APIs, schemas, authentication, geolocation, encryption, offline persistence, or public claims, update the relevant documentation and add regression tests.

## Commit style

Use a concise conventional prefix when practical, such as `fix:`, `feat:`, `docs:`, `test:`, `security:`, or `chore:`. The subject should describe the change and its scope.
