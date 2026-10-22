# build from repo root: docker build -f apps/web/Dockerfile .
# The web app as static files behind Caddy, which also hands the API's paths to the api service and takes care of HTTPS.
FROM oven/bun:1.4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --filter @nouvex/web
RUN cd apps/web && bun run build

FROM caddy:2
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv
