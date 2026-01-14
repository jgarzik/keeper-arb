FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Build dashboard
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm ci

COPY dashboard ./dashboard
RUN cd dashboard && npm run build

# Production image
FROM node:20-slim

WORKDIR /app

# Create non-root user
RUN groupadd -r keeper && useradd -r -g keeper keeper

# Install production dependencies only
COPY package*.json ./
RUN npm ci --production && npm cache clean --force

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Create data directories
RUN mkdir -p data logs && chown -R keeper:keeper /app

# Switch to non-root user
USER keeper

# Environment
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV LOGS_DIR=/app/logs
ENV DASHBOARD_PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/status || exit 1

CMD ["node", "dist/index.js"]
