# syntax=docker/dockerfile:1.7
FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73 AS toolchain

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

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:af85d11ce7ef10172855a6e3649e3e8125b1b9e3ca41849ec2918036f05cb212 AS runtime

ARG VERSION=0.0.0
ARG REVISION=unknown
ARG SOURCE=https://github.com/radium0090/Compute-Gateway
ENV NODE_ENV=production \
    GENCHI_SERVICE_VERSION=$VERSION \
    GENCHI_COMMIT_SHA=$REVISION
WORKDIR /app

LABEL org.opencontainers.image.title="Genchi Compute Gateway" \
      org.opencontainers.image.description="Open-source AI compute gateway" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION" \
      org.opencontainers.image.source="$SOURCE" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --from=build --chown=65532:65532 /opt/genchi/ ./
COPY --from=build --chown=65532:65532 /workspace/db/migrations/ ./db/migrations/

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
