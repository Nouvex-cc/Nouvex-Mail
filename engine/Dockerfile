FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /engine ./cmd/engine

FROM gcr.io/distroless/static
COPY --from=build /engine /engine
ENTRYPOINT ["/engine"]
