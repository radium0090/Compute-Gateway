# syntax=docker/dockerfile:1.7
FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS toolchain

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

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime

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
