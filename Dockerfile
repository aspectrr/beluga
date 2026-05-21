# ── Beluga Runtime ─────────────────────────────────────────────
FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
RUN bun build src/main.ts --outdir dist --target bun

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "run", "dist/main.js", "start", "-c", "/etc/beluga/config.json"]
