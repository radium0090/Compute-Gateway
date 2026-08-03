# syntax=docker/dockerfile:1.7
FROM node:24.13.0-bookworm-slim AS toolchain

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace

FROM toolchain AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
RUN pnpm build
RUN pnpm --filter @genchi/gateway deploy --prod /opt/genchi

FROM node:24.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=10001:10001 /opt/genchi/ ./
COPY --from=build --chown=10001:10001 /workspace/db/migrations/ ./db/migrations/

USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]
