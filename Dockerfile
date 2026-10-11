FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:web

FROM node:22-slim
ENV NODE_ENV=production \
    LLMPOD_IN_DOCKER=1 \
    LLMPOD_CONFIG_DIR=/config \
    ZCODE_DIR=/zcode \
    PI_CODING_AGENT_DIR=/pi \
    LLMPOD_UI_HOST=0.0.0.0 \
    LLMPOD_PROXY_HOST=0.0.0.0 \
    LLMPOD_UI_PORT=7860 \
    LLMPOD_PROXY_PORT=8081
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY data ./data
COPY --from=build /app/dist ./dist
RUN mkdir -p /config /zcode /pi && chown node:node /config /zcode /pi
USER node
EXPOSE 7860 8081
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD node -e "const p=process.env.LLMPOD_UI_PORT||7860;fetch('http://127.0.0.1:'+p+'/api/health',{headers:{host:'127.0.0.1:'+p}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "src/cli/index.js"]
CMD ["ui", "--no-open"]
