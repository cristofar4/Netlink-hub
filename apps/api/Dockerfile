# NetLink control plane.
#
# Multi-stage, and the split matters: the build stage needs the whole npm
# workspace (the API imports @netlink/contracts from source), while the runtime
# stage needs only the compiled output and production dependencies. Shipping the
# build toolchain would roughly triple the image and put a bundler, a compiler
# and their transitive dependencies inside the thing facing the internet.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /repo

# Manifests first, so a change to source code does not invalidate the
# dependency layer. This is the difference between a 20-second rebuild and a
# three-minute one.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY apps/api/package.json apps/api/

# The desktop and mobile workspaces are not needed to build the API, and
# installing React Native here would add hundreds of megabytes for nothing.
RUN npm ci --workspace=@netlink/contracts --workspace=@netlink/api --include-workspace-root

COPY packages/contracts packages/contracts
COPY apps/api apps/api

RUN npm run build --workspace=@netlink/contracts \
 && npx --workspace=@netlink/api prisma generate \
 && npm run build --workspace=@netlink/api

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# openssl is required by Prisma's query engine. curl is the health check.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts ./packages/contracts
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
COPY --from=build /repo/apps/api/package.json ./package.json

# Runs as a non-root user. The `node` image ships one, and a process that never
# needs to write outside its own working directory has no reason to be root.
USER node

EXPOSE 4000
ENV HOST=0.0.0.0 PORT=4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health/live" || exit 1

# Migrations run on boot rather than as a separate step, so a deploy cannot
# start an image whose schema does not match its code. `migrate deploy` only
# applies migrations that already exist — it never generates one, and never
# resets anything.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
