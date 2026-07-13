# ── LeadPilot frontend (Next.js) ─────────────────────────────────────────────
# Build stage
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* are baked into the client bundle at BUILD time, so they must be the
# PRODUCTION values (passed as build args from docker-compose).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_API_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY

RUN npm run build

# Run stage
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.js ./next.config.js

EXPOSE 3000
CMD ["npm", "start"]
