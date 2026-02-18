# AI Daily

一站式 AI 技术日报服务，自动抓取 94 个顶级技术博客，AI 评分筛选，推送到 Telegram。

## 🚀 快速开始

```bash
# 克隆或下载项目后
cd docker
docker-compose up -d --build
```

访问 **http://localhost:25333** 进入管理后台

- 默认账号：`admin`
- 默认密码：`admin123`

## ✨ 功能特性

| 功能 | 描述 |
|------|------|
| 🤖 LLM 主备切换 | 主 LLM 失败自动切换备用，支持重试策略 |
| 📡 94 个 RSS 源 | 来自 Karpathy 推荐的顶级技术博客 |
| 📱 Telegram 推送 | 自动推送摘要，支持一键阅读中文全文 |
| ⏰ 定时任务 | 支持 Cron 表达式，自定义运行时间 |
| 📋 系统日志 | 实时查看运行状态，便于排查问题 |
| 🔐 登录认证 | 账号密码保护，Cookie 会话管理 |

## 📁 目录结构

```
docker/
├── server.ts          # 后端服务（Bun 运行时）
├── admin.html         # Web 管理后台
├── rss-feeds.json     # 默认 RSS 源列表
├── Dockerfile
├── docker-compose.yml
└── data/              # 运行时数据（自动创建）
    ├── config.json    # 配置文件
    ├── articles.json  # 文章缓存（7天自动清理）
    ├── seen.json      # 已推送记录（5000条上限）
    ├── history.json   # 运行历史（30天）
    └── logs.json      # 系统日志（500条上限）
```

## ⚙️ 配置说明

### LLM 配置

支持任何兼容 OpenAI API 格式的服务：

| 服务商 | Base URL 示例 |
|--------|--------------|
| OpenAI | `https://api.openai.com/v1` |
| 硅基流动 | `https://api.siliconflow.cn/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| 本地 Ollama | `http://host.docker.internal:11434/v1` |

### Telegram 配置

1. 通过 [@BotFather](https://t.me/BotFather) 创建 Bot，获取 Token
2. 获取 Chat ID（群组/频道 ID）
3. 设置 Webhook URL（需要 HTTPS）

**Webhook URL 格式**：`https://你的域名/webhook/telegram`

> ⚠️ Telegram 强制要求 HTTPS，建议使用 Nginx/Caddy 反向代理或 Cloudflare Tunnel

### 定时任务

支持简化的 Cron 表达式：

| 示例 | 含义 |
|------|------|
| `0 8` | 每天 8:00 |
| `30 9` | 每天 9:30 |
| `* 8` | 每天 8:00-8:59 每分钟（不推荐）|

## 🔧 常用命令

```bash
# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 重新构建
docker-compose up -d --build

# 停止服务
docker-compose down

# 查看状态
docker-compose ps
```

## 📊 数据管理

系统内置自动清理机制，长期运行无忧：

| 数据类型 | 清理策略 | 最大占用 |
|----------|----------|---------|
| 文章缓存 | 7 天自动过期 | ~2MB |
| 推送记录 | 5000 条上限 | ~500KB |
| 运行历史 | 30 条上限 | ~50KB |
| 系统日志 | 500 条上限 | ~100KB |

每天凌晨 3 点自动执行清理任务。

## 🌐 反向代理示例

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name daily.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:25333;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### Caddy

```
daily.example.com {
    reverse_proxy localhost:25333
}
```

## 📝 API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/status` | GET | 服务状态 |
| `/api/config` | GET/POST | 配置管理 |
| `/api/rss` | GET/POST | RSS 源管理 |
| `/api/run` | POST | 手动运行 |
| `/api/history` | GET | 运行历史 |
| `/api/logs` | GET | 系统日志 |
| `/webhook/telegram` | POST | Telegram 回调 |

> 除 `/api/status` 和 `/webhook/telegram` 外，其他接口需要登录认证

## 🐛 常见问题

### Q: Webhook 设置失败？
A: 确保 URL 是 HTTPS，且域名可被 Telegram 服务器访问

### Q: LLM 调用超时？
A: 在 LLM 设置中增加超时时间，或配置备用 LLM

### Q: 如何迁移数据？
A: 备份 `docker/data/` 目录即可，包含所有配置和缓存

### Q: 如何自定义 RSS 源？
A: 在管理后台「RSS 源」页面添加/编辑/删除

## 📜 License

MIT
