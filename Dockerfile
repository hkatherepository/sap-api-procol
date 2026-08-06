FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S integration && adduser -S -G integration -u 10001 integration
COPY --from=build --chown=integration:integration /app/node_modules ./node_modules
COPY --from=build --chown=integration:integration /app/dist ./dist
COPY --chown=integration:integration package.json ./package.json
USER 10001
EXPOSE 3000
CMD ["node", "dist/main.js"]
