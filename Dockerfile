# =============================================================
# ALFEAN ENTERPRISES - production image (Coolify / VPS)
#
# NOTE: Build context MUST be the repo root (../..) because this
# builds BOTH the React client and the backend. The canonical file
# is the root Dockerfile; this copy exists for convenience.
# =============================================================

# ---------- Stage 1: build the React client ----------
FROM node:22-alpine AS client-build
WORKDIR /build
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# vite outDir = ../backend/public
RUN npm run build

# ---------- Stage 2: build the backend ----------
FROM node:22-alpine AS backend-build
WORKDIR /build
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
# Bring in the freshly-built frontend (gitignored, not in the source tree)
COPY --from=client-build /backend/public ./public
RUN npm run build

# ---------- Stage 3: production runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=backend-build /build/dist ./dist
# Client dependency manifests (used by the developer Dependencies panel)
COPY --from=client-build /build/package.json ./client-package.json
COPY --from=client-build /build/package-lock.json ./client-package-lock.json
# Static frontend at the path the runtime reads (process.cwd()/public)
COPY --from=backend-build /build/public ./public
COPY --from=backend-build /build/src/database/migrations ./src/database/migrations

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]