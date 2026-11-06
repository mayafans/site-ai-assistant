# 站内 AI 助手 —— 运行镜像
# 构建：docker build -t site-ai-assistant .
# 运行：docker run -d -p 8820:8820 -e HOST=0.0.0.0 \
#         -e ADMIN_USER=admin -e ADMIN_PASSWORD='***' \
#         -v /opt/ai-assistant/data:/app/data --restart=always site-ai-assistant
FROM node:20-alpine

WORKDIR /app

# 只拷运行期需要的东西，data/ 由 volume 挂载（配置与口令不进镜像）
COPY package.json ./
COPY server.mjs build-widget.mjs ./
COPY src ./src
COPY public ./public
COPY shared ./shared

# 构建前端产物（src/sdk.js → public/widget.js）
RUN node build-widget.mjs

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8820

EXPOSE 8820

CMD ["node", "server.mjs"]
