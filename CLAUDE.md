# Nouvex Mail

Nouvex Mail is an open-source email client (successor of "Mail Sync") that keeps all of a user's email accounts in sync on every device: iOS, macOS and web, Android later. Long term it becomes an embeddable component that lets other developers ship a modern email client inside their own apps with little effort.

## Architecture

- Sync engine (Go): the only service that talks to mail providers (IMAP, SMTP, OAuth2) and writes mailbox data.
- API (TypeScript, Hono): the only entry point for clients. Auth, users, settings, delta sync endpoints, WebSockets.
- API and engine only talk over NATS: commands (API → engine, JetStream stream `COMMANDS`, subjects `cmd.>`) and events (engine → API, pub-sub `evt.>`). No direct calls.
- Data: PostgreSQL for metadata and the change log, S3-compatible object storage for message bodies and attachments.
- Clients are local-first and only fetch changes through a JMAP-inspired delta sync (`change_log`, monotonic version per account).

## Repo

```
apps/api         Hono + zod-openapi, BetterAuth, Drizzle (schema + migrations in drizzle/)
apps/web         Vite, React, TanStack Router/Query, Tailwind, shadcn/ui, Dexie
apps/site        Next.js, website and docs only
apps/apple       SwiftUI multiplatform, GRDB, swift-openapi-generator (project via xcodegen)
engine           Go module: go-imap v2, go-smtp, go-message, go-msgauth, pgx + sqlc, NATS
packages/schema  JSON schemas for NATS messages, TS and Go types are generated from them
packages/sdk     Headless client core (Apache-2.0)
```

## Commands

```sh
docker compose up -d                # Postgres, NATS, SeaweedFS (S3), Stalwart, Mailpit
docker compose --profile obs up -d  # + Grafana/OTel (localhost:3001)
bun dev                             # everything via Turbo
bunx turbo lint typecheck test build
bun run db:generate                 # new migration from src/db/schema.ts
bun run db:migrate
bun run gen                         # TS/Go types from packages/schema + sqlc
bun run openapi                     # rewrite apps/apple/Nouvex/openapi.json
bun run e2e                         # e2e tests
cd apps/apple && xcodegen           # generate the Xcode project
```

## Stack

- Go: go-imap v2, go-smtp, go-sasl, go-message, go-msgauth, pgx + sqlc, slog, OpenTelemetry, Sentry
- TypeScript: Bun (runtime and package manager), Hono + @hono/zod-openapi, BetterAuth, Drizzle, Biome
- Web: Vite, React, TanStack Router and Query, Tailwind, shadcn/ui, Dexie, DOMPurify
- Apple: SwiftUI multiplatform, GRDB, swift-openapi-generator
- Infra: Bun workspaces + Turborepo, Docker, NATS JetStream, PostgreSQL

## Rules

- Everything is in English: code, comments, UI copy, docs, commits, PRs, issues.
- Always use the latest stable version of every tool. When unsure, check the current docs instead of working from memory.
- Change the database schema only through Drizzle migrations, then regenerate the Go code with sqlc (`bun run gen`).
- Only the Go engine writes mailbox tables.
- The API contract is OpenAPI generated from Zod schemas. Every route needs an `operationId`. The Swift client is generated from it, never maintained by hand.
- Define NATS messages only in `packages/schema`, never duplicate the types by hand.
- Always store credentials and tokens encrypted (envelope encryption) and never log them.
- Render HTML mail only in a sandboxed iframe with DOMPurify, remote images go through the image proxy.
- Go: golangci-lint must pass, tests run with -race. TypeScript: bun test, Vitest in web. E2E tests with e2e by TesterArmy (docs offline in `node_modules/e2e/docs`).
- Manage and run packages only with bun and bunx, never npm, npx, pnpm or yarn.
- Current scope: IMAP and SMTP first. Gmail OAuth and the Gmail API are deliberately postponed.

## License

AGPL-3.0 for server and engine, Apache-2.0 for SDK and component. Every file has an SPDX header, and SDK code must never import AGPL code.
