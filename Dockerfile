# ── Beluga Daemon ───────────────────────────────────────────────
# Multi-stage build for the Beluga daemon binary.

FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /beluga ./cmd/beluga

# ── Runtime ────────────────────────────────────────────────────
FROM alpine:3.21

RUN apk add --no-cache ca-certificates

COPY --from=builder /beluga /usr/local/bin/beluga

ENTRYPOINT ["beluga"]
CMD ["start", "--config", "/etc/beluga/config.yaml"]
