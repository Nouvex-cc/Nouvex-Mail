FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# The engine and the MX (cmd/mx) in one image; deploy/compose.yml picks one per service.
RUN CGO_ENABLED=0 go build -o /out/ ./cmd/engine ./cmd/mx

FROM gcr.io/distroless/static
COPY --from=build /out/ /
ENTRYPOINT ["/engine"]
