FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/extension apps/extension
COPY packages/i18n/package.json packages/i18n/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/i18n packages/i18n
RUN pnpm --filter @slide-helper/extension exec wxt zip
RUN pnpm --filter @slide-helper/web build

FROM nginx:1.27-alpine AS runtime

COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html
COPY --from=builder /workspace/apps/extension/.output/slideact-extension.zip /usr/share/nginx/html/downloads/slideact-extension.zip
EXPOSE 8080
