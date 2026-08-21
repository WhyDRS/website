FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY astro.config.mjs migration-manifest.json ./
COPY public ./public
COPY scripts ./scripts
COPY site ./site
COPY src/data ./src/data
RUN npm run build && npm run validate

FROM nginx:1.29-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
