FROM oven/bun:1.3-slim
WORKDIR /app
COPY server.ts db.ts template.ts ./
COPY public ./public
EXPOSE 3000
CMD ["bun", "run", "server.ts"]
