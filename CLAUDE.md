# Nouvex Mail

Nouvex Mail ist ein Open-Source-E-Mail-Client (Nachfolger von „Mail Sync“), der alle E-Mail-Accounts eines Nutzers auf jedem Gerät synchron hält: iOS, macOS und Web, später Android. Langfristig entsteht daraus eine einbettbare Komponente, mit der andere Entwickler mit wenig Aufwand einen modernen E-Mail-Client in ihre eigenen Apps einbauen können.

## Architektur

- Sync-Engine (Go): der einzige Dienst, der mit Mail-Providern spricht (IMAP, SMTP, OAuth2) und Postfach-Daten schreibt.
- API (TypeScript, Hono): der einzige Einstiegspunkt für Clients. Auth, Nutzer, Einstellungen, Delta-Sync-Endpunkte, WebSockets.
- API und Engine sprechen nur über NATS miteinander: Befehle (API → Engine, JetStream-Stream `COMMANDS`, Subjects `cmd.>`) und Events (Engine → API, Pub-Sub `evt.>`). Keine direkten Aufrufe.
- Daten: PostgreSQL für Metadaten und Change-Log, S3-kompatibler Object Storage für Mail-Inhalte und Anhänge.
- Clients sind lokal-first und holen nur Änderungen über ein JMAP-inspiriertes Delta-Sync (`change_log`, monotone Version pro Account).

## Repo

```
apps/api         Hono + zod-openapi, BetterAuth, Drizzle (Schema + Migrationen in drizzle/)
apps/web         Vite, React, TanStack Router/Query, Tailwind, shadcn/ui, Dexie
apps/site        Next.js, nur Website und Docs
apps/apple       SwiftUI Multiplatform, GRDB, swift-openapi-generator (Projekt per xcodegen)
engine           Go-Modul: go-imap v2, go-smtp, go-message, go-msgauth, pgx + sqlc, NATS
packages/schema  JSON-Schemas der NATS-Nachrichten, daraus TS- und Go-Typen
packages/sdk     Headless-Client-Core (Apache-2.0)
```

## Befehle

```sh
docker compose up -d              # Postgres, NATS, SeaweedFS (S3), Stalwart, Mailpit
docker compose --profile obs up -d  # + Grafana/OTel (localhost:3001)
bun dev                           # alles über Turbo
bunx turbo lint typecheck test build
bun run db:generate               # Migration aus src/db/schema.ts erzeugen
bun run db:migrate
bun run gen                       # TS-/Go-Typen aus packages/schema + sqlc
bun run openapi                   # apps/apple/Nouvex/openapi.json neu schreiben
cd apps/apple && xcodegen         # Xcode-Projekt erzeugen
```

## Stack

- Go: go-imap v2, go-smtp, go-sasl, go-message, go-msgauth, pgx + sqlc, slog, OpenTelemetry, Sentry
- TypeScript: Bun (Runtime und Paketmanager), Hono + @hono/zod-openapi, BetterAuth, Drizzle, Biome
- Web: Vite, React, TanStack Router und Query, Tailwind, shadcn/ui, Dexie, DOMPurify
- Apple: SwiftUI Multiplatform, GRDB, swift-openapi-generator
- Infrastruktur: Bun Workspaces + Turborepo, Docker, NATS JetStream, PostgreSQL

## Regeln

- Immer die neueste stabile Version jeder Technik nutzen. Bei Unsicherheit die aktuelle Dokumentation prüfen, nicht aus dem Gedächtnis arbeiten.
- Datenbankschema nur über Drizzle-Migrationen ändern, danach den Go-Code mit sqlc neu generieren (`bun run gen`).
- Postfach-Tabellen schreibt ausschließlich die Go-Engine.
- Der API-Vertrag ist OpenAPI aus Zod-Schemas. Jede Route braucht eine `operationId`. Der Swift-Client wird daraus generiert, nie von Hand gepflegt.
- NATS-Nachrichten nur über `packages/schema` definieren, nie Typen von Hand duplizieren.
- Zugangsdaten und Tokens immer verschlüsselt speichern (Envelope-Encryption) und nie loggen.
- HTML-Mails nur im sandboxed iframe mit DOMPurify rendern, Remote-Bilder über den Bild-Proxy.
- Go: golangci-lint muss grün sein, Tests laufen mit -race. TypeScript: bun test, im Web Vitest. E2E-Tests mit e2e by TesterArmy (`bun run e2e`, Doku offline in `node_modules/e2e/docs`).
- Pakete nur mit bun und bunx verwalten und ausführen, nie mit npm, npx, pnpm oder yarn.
- Aktueller Scope: IMAP und SMTP first. Gmail-OAuth und Gmail API sind bewusst zurückgestellt.

## Lizenz

AGPL-3.0 für Server und Engine, Apache-2.0 für SDK und Komponente. Jede Datei trägt einen SPDX-Header, und SDK-Code darf niemals AGPL-Code importieren.
