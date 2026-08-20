FROM node:22-alpine
WORKDIR /app
COPY fluxdots-mcp.mjs ./
ENTRYPOINT ["node", "fluxdots-mcp.mjs"]
