FROM oven/bun:alpine

# 设置时区
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata

WORKDIR /app

# 复制核心文件
COPY server.ts admin.html rss-feeds.json ./

EXPOSE 25333

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:25333/api/status || exit 1

CMD ["bun", "run", "server.ts"]
