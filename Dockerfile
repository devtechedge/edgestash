# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter edgestash...
COPY packages/server packages/server
RUN pnpm --filter edgestash build && pnpm --filter edgestash deploy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production EDGESTASH_PORT=3333 EDGESTASH_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out .
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3333
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3333/healthz || exit 1
CMD ["node", "dist/cli.js"]
