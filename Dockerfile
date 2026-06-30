# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/home/node
ENV CODEX_BIN=codex
ENV CODEX_HOME=/home/node/.codex-tentix-inspector
ENV AGENT_CHILD_PATH=/home/node/.local/share/tentix-codex/bin:/usr/local/bin:/usr/bin:/bin
ENV AGENT_READONLY_KUBECTL_COMMAND=kubectl-ByAgent-READONLY
ENV AIPROXY_BRIDGE_ENABLED=true
ENV AIPROXY_BRIDGE_HOST=127.0.0.1
ENV AIPROXY_BRIDGE_PORT=18087
ENV AIPROXY_BRIDGE_BIN=/app/runtime/aiproxy-responses-chat-bridge.js
ENV CODEX_SKILL_ROOT=/home/node/.codex-tentix-inspector/skills/tentix-sealos-ticket

ARG CODEX_VERSION=0.141.0
ARG KUBECTL_VERSION=v1.30.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex@${CODEX_VERSION} \
  && mkdir -p /home/node/.local/share/tentix-codex/internal \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    amd64) kubectl_arch="amd64" ;; \
    arm64) kubectl_arch="arm64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${kubectl_arch}/kubectl" \
    -o /home/node/.local/share/tentix-codex/internal/kubectl \
  && chmod 0755 /home/node/.local/share/tentix-codex/internal/kubectl

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts ./scripts

RUN mkdir -p \
    /app/kubeconfig \
    /app/runtime \
    /home/node/.codex-tentix-inspector \
    /home/node/.local/share/tentix-codex/bin \
  && chmod 0755 \
    /app/scripts/docker-entrypoint.sh \
    /app/scripts/container-healthcheck.sh \
    /app/scripts/kubectl-ByAgent-READONLY \
  && ln -sf /app/scripts/kubectl-ByAgent-READONLY \
    /home/node/.local/share/tentix-codex/bin/kubectl-ByAgent-READONLY \
  && chown -R node:node /app /home/node

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/app/scripts/container-healthcheck.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/docker-entrypoint.sh"]
CMD ["node", "dist/server/http-server.js"]
