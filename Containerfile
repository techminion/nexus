FROM node:22-bookworm-slim AS build
# pnpm itself (corepack), the package store and registry metadata live in build caches that survive `podman image prune`,
# so rebuilds reuse them instead of refetching everything from the registry.
ENV COREPACK_HOME=/cache/corepack npm_config_store_dir=/cache/pnpm-store npm_config_cache_dir=/cache/pnpm-meta npm_config_fetch_retries=5
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=nexus-corepack,target=/cache/corepack --mount=type=cache,id=nexus-pnpm-store,target=/cache/pnpm-store --mount=type=cache,id=nexus-pnpm-meta,target=/cache/pnpm-meta pnpm install --frozen-lockfile --prefer-offline
COPY apps apps
RUN --mount=type=cache,id=nexus-corepack,target=/cache/corepack pnpm build
RUN --mount=type=cache,id=nexus-corepack,target=/cache/corepack --mount=type=cache,id=nexus-pnpm-store,target=/cache/pnpm-store --mount=type=cache,id=nexus-pnpm-meta,target=/cache/pnpm-meta pnpm --filter @nexus/server deploy --prod --legacy --prefer-offline /out

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXUS_DATA_DIR=/data PORT=3000 WEB_DIST=/app/web
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json package.json
COPY --from=build /app/apps/server/dist dist
COPY --from=build /app/apps/web/dist web
EXPOSE 3000
CMD ["node", "dist/index.js"]
