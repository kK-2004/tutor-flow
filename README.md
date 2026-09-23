# Tutor Flow 内容工作台

小红书单平台内容生产系统：检索溯源 → 去重评分 → 事实绑定 → 方向决策 → 内容生成 → 人工审核 → 幂等发布。

## 仓库结构

```
apps/
  console   管理后台（Next.js）
  api       控制面 API（Fastify）
  worker    队列处理器（BullMQ：研究、生成、发布）
packages/
  domain        领域枚举、状态机、命令与事件类型
  db            SQLite 迁移、schema 与仓储
  workflow      工作流引擎：检查点推进、失败处置、恢复扫描
  integrations  搜索、抓取、LLM、对象存储与小红书发布适配器
  ui            共享界面组件与设计变量
  config        环境配置校验与密钥提供器
```

## Docker Compose 启动

根目录 Compose 编排管理台、API、Worker、数据库迁移和小红书 MCP。Redis 与内容中心继续使用已部署的外部服务，不会创建 Redis 容器。

首次启动前，准备 `.env`。宿主机 Redis `localhost:6379` 已对应配置为 `redis://host.docker.internal:6379`；若 Redis 在其他服务器，则将 `REDIS_URL` 改为容器网络可达的地址。

```bash
# 准备环境变量并配置外部 Redis 地址
cp .env.example .env

# 根 Compose 会连接已有的 common-net；本机没有该网络时创建一个
docker network inspect common-net >/dev/null 2>&1 || docker network create common-net

# 构建并启动整个项目
docker compose up --build -d

# 查看运行状态与日志
docker compose ps
docker compose logs -f api worker console
```

管理台默认访问 `http://localhost:8003`（宿主机端口 `8003` 映射到容器端口 `3000`），API 默认端口为 `4000` 且只绑定宿主机回环地址。生产部署的管理台也默认绑定 `127.0.0.1:8003`，由 Nginx 通过 HTTPS 域名反向代理访问。SQLite 数据持久化在 Compose 命名卷 `tutor-flow-data`；小红书扫码登录态保存在 `mcp/xhs/data`。`docker compose down` 不会删除这些数据。不要同时启动 `mcp/xhs/docker-compose.yml` 中的 MCP 服务。

API、Worker、管理台和小红书 MCP 都加入外部 `common-net`，以便互相访问并连接同网络中的 Redis。线上 `REDIS_URL` 默认使用 `redis://redis:6379`；若 Redis 的网络别名不同，在 GitHub Actions Secret `REDIS_URL` 中填写对应地址。

首次启动可使用 `.env` 中的 `BOOTSTRAP_SUPER_ADMIN_USERNAME` 与
`BOOTSTRAP_SUPER_ADMIN_PASSWORD` 登录管理台。默认值为 `admin` / `change-me-now-123`，
仅适合本机首次启动，登录后应立即在系统设置中修改密码；已有超级管理员时不会覆盖密码。
管理员密码至少 5 位。

后台角色分为 `SUPER_ADMIN` 与 `ADMIN`，两者具有相同业务操作权限。只有
`SUPER_ADMIN` 可以创建 `ADMIN`，并以随机生成或指定密码的方式重置其密码；
`ADMIN` 只能修改自己的密码。后台会话保存在 HttpOnly Cookie 中，浏览器不再持有
运营 Bearer token；会话有效期为 90 天。

进入概览后点击“登录账号”模块即可获取小红书二维码。扫码成功后页面会自动检查
登录状态，Cookie 由 MCP sidecar 持久化到 `mcp/xhs/data`。

Compose 内 API 和 Worker 通过 `http://xiaohongshu-mcp:18060/mcp` 访问 MCP。发布消费还需要在 `.env` 设置 `XHS_MCP_ACCOUNT_ID`，绑定平台中的当前账号。访问地址和端口可通过 `TUTOR_FLOW_BIND_ADDRESS`、`API_PUBLISHED_PORT`、`CONSOLE_PORT` 与 `XHS_MCP_PORT` 调整；默认只绑定本机回环地址。

## 本机源码开发

API、Worker 和管理台也可以直接在宿主机运行。前置要求：Node.js >= 20.9、pnpm >= 10。

```bash
# 安装依赖并准备环境变量
pnpm install
cp .env.example .env

# 本机运行应用时，仅启动 MCP sidecar
docker compose up -d xiaohongshu-mcp

# 初始化数据库并构建
pnpm db:migrate
pnpm build && pnpm lint && pnpm typecheck && pnpm test

# 分别启动应用进程（各自终端）
pnpm dev:api
pnpm dev:worker
pnpm dev:console
```

宿主机运行 API 和 Worker 时，将 `XHS_MCP_URL` 设置为 `http://127.0.0.1:18060/mcp`，并按宿主机网络配置 `REDIS_URL`。

内容中心的应用令牌、MinIO 数据源与浏览器直传要求见 [接入说明](docs/content-center.md)。

小红书发布辅助进程（MCP sidecar）镜像版本固定与契约验证见 OpenSpec 变更任务 6.3。

## 规范约束

- 所有代码注释使用中文（见 AGENTS.md）。
- 管理后台禁止使用 Emoji 与任何形式的 SVG 作为界面图标，统一使用
  Font Awesome Free CSS/Webfont（任务 7.2）。
- 敏感凭据一律通过 `@tutor-flow/config/server` 的密钥提供器解析，
  客户端代码只能使用 `@tutor-flow/config/client`。
