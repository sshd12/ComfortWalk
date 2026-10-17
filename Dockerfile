# ---- build the React front end ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- run the server (also serves the built front end) ----
FROM node:22-slim
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production
CMD ["node", "server/server.js"]
