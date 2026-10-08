# Multi-stage: the runtime image carries no compiler, no sources and no dev deps.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json  packages/shared/
COPY packages/backend/package.json packages/backend/
COPY packages/bot/package.json     packages/bot/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci --ignore-scripts --workspaces --include-workspace-root

COPY packages/shared  packages/shared
COPY packages/backend packages/backend
COPY tsconfig*.json ./
RUN npm run build -w @cb/shared && npm run build -w @cb/backend

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules            ./node_modules
COPY --from=build --chown=app:app /app/package.json            ./package.json
COPY --from=build --chown=app:app /app/packages/shared/dist    ./packages/shared/dist
COPY --from=build --chown=app:app /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=app:app /app/packages/backend/dist   ./packages/backend/dist
COPY --from=build --chown=app:app /app/packages/backend/package.json ./packages/backend/package.json
COPY --chown=app:app database ./database

USER app
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/backend/dist/index.js"]
