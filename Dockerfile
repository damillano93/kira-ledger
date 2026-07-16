# ---- build stage ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
# tsx is needed to run the migration script (TypeScript) at boot.
RUN npm install tsx@^4.16.2
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY src ./src
COPY migrations ./migrations
EXPOSE 3000
# Run migrations, then start the server.
CMD ["sh", "-c", "npx tsx scripts/migrate.ts && node dist/src/server.js"]
