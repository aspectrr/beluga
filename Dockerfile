# ── Beluga Runtime ─────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

COPY . .
RUN bun install

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "src/main.ts", "start", "-c", "/etc/beluga/config.json"]
