FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/shared/package.json   packages/shared/
COPY packages/backend/package.json  packages/backend/
COPY packages/bot/package.json      packages/bot/
COPY packages/frontend/package.json packages/frontend/
RUN npm ci --ignore-scripts --workspaces --include-workspace-root

COPY packages/shared   packages/shared
COPY packages/frontend packages/frontend
RUN npm run build -w @cb/frontend

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
