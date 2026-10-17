FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev
COPY sql ./sql
COPY src ./src
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321
CMD ["node", "--experimental-strip-types", "src/server.ts"]
