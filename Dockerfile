# syntax=docker/dockerfile:1.7

FROM node:24.13.1-trixie-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build

COPY src ./src
COPY tsconfig.json tsdown.config.ts ./
RUN pnpm run build

FROM base AS prod-deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM node:24.13.1-trixie AS runtime

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH
ENV LUNA_HOME=/home/node/.luna

WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY templates ./templates

USER node

CMD ["./dist/index.mjs"]
