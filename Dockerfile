# syntax=docker/dockerfile:1.27
FROM node:24.21.0-trixie-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store,sharing=locked \
    --mount=type=cache,target=/root/.cache/pnpm,sharing=locked \
    pnpm install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts
COPY templates ./templates
COPY tsconfig.json tsdown.config.ts ./
RUN pnpm run gen
RUN pnpm run build
RUN mkdir -p /app/codex-runtime/node_modules/@openai /app/codex-runtime/node_modules/.bin && \
    cp -LR /app/node_modules/@openai/codex /app/codex-runtime/node_modules/@openai/codex && \
    cp -LR /app/node_modules/.pnpm/node_modules/@openai/codex-linux-$(node -p 'process.arch') \
      /app/codex-runtime/node_modules/@openai/codex-linux-$(node -p 'process.arch') && \
    ln -s ../@openai/codex/bin/codex.js /app/codex-runtime/node_modules/.bin/codex


FROM node:24.21.0-trixie AS runtime

ENV NODE_ENV=production
ENV PATH=/app/codex-runtime/node_modules/.bin:$PATH
ENV LUNA_HOME=/home/node/.luna

WORKDIR /app

RUN rm -f /etc/apt/apt.conf.d/docker-clean; echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get --no-install-recommends install -y ca-certificates git sudo wget tini && \
    mkdir -p -m 755 /etc/apt/keyrings && \
    wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y gh

RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node && \
    chmod 0440 /etc/sudoers.d/node && \
    mkdir -p /home/node/.luna && \
    chown node:node /home/node/.luna

COPY --from=build /app/dist/luna-chat ./dist/luna-chat
COPY --from=build /app/codex-runtime ./codex-runtime

USER node

ENTRYPOINT ["tini", "--"]
CMD ["./dist/luna-chat"]
