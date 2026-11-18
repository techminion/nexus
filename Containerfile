FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY apps apps
RUN pnpm build
RUN pnpm --filter @nexus/server deploy --prod --legacy --prefer-offline /out

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXUS_DATA_DIR=/data PORT=3000 WEB_DIST=/app/web
COPY --from=build /out/node_modules node_modules
COPY --from=build /out/package.json package.json
COPY --from=build /app/apps/server/dist dist
COPY --from=build /app/apps/web/dist web
EXPOSE 3000
CMD ["node", "dist/index.js"]
