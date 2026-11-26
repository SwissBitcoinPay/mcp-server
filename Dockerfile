# The hosted server (mcp.sattle.me, docs/HOSTING.md): built from the lockfile, run as a non-root
# user, without dev dependencies nor install scripts. Node's version is .nvmrc's.
FROM node:22.22.2-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY vendor ./vendor
# The invoice card (src/mcp/card.ts): built from ui/ with its logo into dist/ui/.
COPY ui ./ui
COPY scripts/ui.mjs ./scripts/ui.mjs
COPY assets/favicon.png ./assets/favicon.png
RUN npm run build

FROM node:22.22.2-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER node
EXPOSE 8080
CMD ["node", "dist/src/http.js"]
