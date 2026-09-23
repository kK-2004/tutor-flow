FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/console/package.json ./apps/console/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/integrations/package.json ./packages/integrations/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/workflow/package.json ./packages/workflow/package.json

RUN mkdir -p /data && chown -R node:node /app /data
USER node

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

ARG NEXT_PUBLIC_API_BASE_URL=
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}

RUN pnpm -r --workspace-concurrency=1 build

ENV SQLITE_PATH=/data/tutor-flow.db
EXPOSE 3000 4000 4100

CMD ["pnpm", "--filter", "@tutor-flow/api", "start"]
