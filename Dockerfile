# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# pnpm 11.21.0 requires Node.js >=22.13 and uses node:sqlite.
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

# ---- Runtime stage ----
FROM node:22-alpine
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@11.21.0 --activate
COPY package.json pnpm-lock.yaml ./
# --prod: install only runtime dependencies from the committed lockfile.
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
# firebase-applet-config.json is ignored in .dockerignore (contains credentials),
# so it cannot be COPYed here without failing the build when absent.
# Provide it at runtime via:
#   docker run -v ./firebase-applet-config.json:/app/firebase-applet-config.json ...
# or set FIREBASE_SERVICE_ACCOUNT. Without config the server runs degraded
# (see server/firebase.ts).
USER nodejs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.cjs"]
