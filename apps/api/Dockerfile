# build from repo root: docker build -f apps/api/Dockerfile .
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --filter @nouvex/api
RUN cd apps/api && bun run build

FROM oven/bun:1.4-slim
WORKDIR /app
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/api/drizzle ./drizzle
EXPOSE 3000
# The schema is brought up to date before the server takes requests.
CMD ["sh", "-c", "bun dist/migrate.js && exec bun dist/index.js"]
