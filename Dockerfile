# ── UI Build ───────────────────────────────────────────────────
FROM oven/bun:1 AS ui-builder
WORKDIR /app/ui

COPY ui/package.json ui/bun.lock ./
RUN bun install --frozen-lockfile

COPY ui/ .
RUN bun run build

# ── Beluga Runtime ─────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/sdk/src packages/sdk/src
RUN bun install --frozen-lockfile --production

COPY src src
COPY --from=ui-builder /app/ui/dist ui/dist

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "src/main.ts", "start", "-c", "/etc/beluga/config.json"]
