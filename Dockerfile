# syntax=docker/dockerfile:1.7

FROM node:24.13.1-trixie-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable

FROM base AS deps

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build

COPY src ./src
COPY tsconfig.json tsdown.config.ts ./
RUN pnpm run build

FROM base AS prod-deps

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM node:24.13.1-trixie-slim AS runtime

ENV NODE_ENV=production
ENV LUNA_HOME=/home/node/.luna

WORKDIR /app

RUN npm install --global @openai/codex

COPY --from=build /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./

USER node

CMD ["node", "./dist/index.mjs"]
