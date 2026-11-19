# syntax=docker/dockerfile:1.7
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS toolchain

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /workspace

FROM toolchain AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
RUN pnpm build
RUN pnpm --filter @rax-digital/gateway deploy --prod /opt/rax-compute-gateway

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8 AS runtime

ARG VERSION=0.0.0
ARG REVISION=unknown
ARG SOURCE=https://github.com/radium0090/Compute-Gateway
ENV NODE_ENV=production \
    RCG_SERVICE_VERSION=$VERSION \
    RCG_COMMIT_SHA=$REVISION
WORKDIR /app

LABEL org.opencontainers.image.title="RAX Compute Gateway" \
      org.opencontainers.image.description="Open-source AI compute gateway" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="$SOURCE" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build --chown=65532:65532 /opt/rax-compute-gateway/ ./
COPY --from=build --chown=65532:65532 /workspace/db/migrations/ ./db/migrations/

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
