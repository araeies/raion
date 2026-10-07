# Example application image. It contains no observability code or agent configuration:
# Raion connects it to OpenTelemetry through environment variables at deploy time.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
