FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json   packages/shared/
COPY packages/backend/package.json  packages/backend/
COPY packages/bot/package.json      packages/bot/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci --ignore-scripts --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY packages/bot    packages/bot
RUN npm run build -w @cb/shared && npm run build -w @cb/bot
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=app:app /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=app:app /app/packages/bot/dist ./packages/bot/dist
COPY --from=build --chown=app:app /app/packages/bot/package.json ./packages/bot/package.json

USER app
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/bot/dist/index.js"]
