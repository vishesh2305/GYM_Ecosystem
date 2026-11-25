# One image for the API, the background worker and database migrations; the command picks which runs.
# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.cache/pnpm pnpm install --frozen-lockfile \
  && pnpm --filter @gym/api build \
  && pnpm --filter @gym/api deploy --prod --legacy /out

FROM node:24-alpine
# The git commit, so error reports say which release raised them (instrumentation.ts reads RELEASE).
ARG RELEASE=dev
ENV NODE_ENV=production RELEASE=$RELEASE
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Worker: node --import ./dist/instrumentation.mjs dist/worker.mjs   Migrations: node dist/migrate.mjs
CMD ["node", "--enable-source-maps", "--import", "./dist/instrumentation.mjs", "dist/main.mjs"]
