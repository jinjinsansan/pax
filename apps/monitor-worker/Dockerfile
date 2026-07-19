# PAXG/XAUT Monitor Worker (仕様書§13)
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/monitor-worker ./apps/monitor-worker
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pax/monitor-worker... run build

FROM node:22-slim
RUN corepack enable && groupadd -r worker && useradd -r -g worker worker
WORKDIR /app
COPY --from=builder /app ./
USER worker
ENV NODE_ENV=production
ENV HEALTH_FILE=/tmp/health.json
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "apps/monitor-worker/dist/healthcheck.js"]
CMD ["node", "apps/monitor-worker/dist/index.js"]
