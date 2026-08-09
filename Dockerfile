# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# --ignore-scripts: avoid running "prepare: husky" during production install
# (husky is a devDependency not present here; the app is already built in the builder stage)
RUN npm ci --omit=dev --ignore-scripts
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