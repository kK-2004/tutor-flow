# Tutor Flow 内容工作台

小红书单平台内容生产系统：检索溯源 → 去重评分 → 事实绑定 → 方向决策 → 小红书内容生成 → 草稿审核。

## 仓库结构

```
apps/
  console   管理后台（Next.js）
  api       控制面 API（Fastify）
  worker    队列处理器（BullMQ：研究、生成）
packages/
  domain        领域枚举、状态机、命令与事件类型
  db            SQLite 迁移、schema 与仓储
  workflow      工作流引擎：检查点推进、失败处置、恢复扫描
  integrations  搜索、抓取、LLM 与对象存储
  ui            共享界面组件与设计变量
  config        环境配置校验与密钥提供器
```

## Docker Compose 启动

根目录 Compose 使用一个 `app` 容器运行管理台、API 和 Worker，启动业务进程前先执行数据库迁移。Redis 与内容中心继续使用已部署的外部服务，不会创建 Redis 容器。

首次启动前，准备 `.env`。宿主机 Redis `localhost:6379` 已对应配置为 `redis://host.docker.internal:6379`；若 Redis 在其他服务器，则将 `REDIS_URL` 改为容器网络可达的地址。
检索需要在 `.env` 配置 `BRAVE_API_KEY`。本地默认直接连接 Brave；线上部署通过 `BRAVE_PROXY_URL=socks5h://newapi-socks5-tunnel:1080` 使用 `common-net` 中的 SOCKS5 代理。模型 Provider、API Key、Base URL、API 模式和模型 ID 在管理台“系统设置”中配置；模型密钥会加密保存在数据库旁的本地密钥文件中。完成 Provider 与默认模型配置后即可执行内容生成。

```bash
# 准备环境变量并配置外部 Redis 地址
cp .env.example .env

# 根 Compose 会连接已有的 common-net；本机没有该网络时创建一个
docker network inspect common-net >/dev/null 2>&1 || docker network create common-net

# 构建并启动整个项目
docker compose up --build -d

# 查看运行状态与日志
docker compose ps
docker compose logs -f app
```

`app` 容器总内存硬上限为 512 MB，交换空间也计入同一上限；API、Worker、管理台的 Node 老生代堆分别限制为 96/128/128 MB。堆限制不等于进程总内存，仍需观察真实任务下的峰值，超限可能触发 OOM 重启。外部 Redis 不计入该上限。任一业务进程退出会停止其余进程并重启整个容器；停止容器时最多给业务进程 30 秒收尾。

从旧版三个容器升级时，需要使用包含新启动脚本的新镜像，并运行 `docker compose up -d --no-build --remove-orphans --wait`。现有 Actions 已包含这些选项，会清理旧的 `api`、`worker`、`console` 和 `migrate` 容器，继续使用同一个数据卷。首次切换会有短暂服务中断。不要仅修改旧镜像的启动命令，也不要删除数据卷。

管理台默认访问 `http://localhost:8003`（宿主机端口 `8003` 映射到容器端口 `3000`），API 默认端口为 `4000` 且只绑定宿主机回环地址。生产部署的管理台也默认绑定 `127.0.0.1:8003`，由 Nginx 通过 HTTPS 域名反向代理访问。SQLite 数据持久化在 Compose 命名卷 `tutor-flow-data`。`docker compose down` 不会删除这些数据。重新部署使用 `--remove-orphans` 清理旧小红书 MCP 容器；原登录态目录不自动删除。

应用容器加入外部 `common-net`，以便互相访问并连接同网络中的 Redis。线上 `REDIS_URL` 默认使用 `redis://redis:6379`；若 Redis 的网络别名不同，在 GitHub Actions Secret `REDIS_URL` 中填写对应地址。

SQLite 启用 WAL，连接池每个连接最多等待写锁 1 秒。发件箱在事务外投递 Redis，使用发件箱 ID 作为 BullMQ 任务 ID 去重，避免队列阻塞时长时间占用数据库写锁；消费端仍需保持幂等。

首次启动可使用 `.env` 中的 `BOOTSTRAP_SUPER_ADMIN_USERNAME` 与
`BOOTSTRAP_SUPER_ADMIN_PASSWORD` 登录管理台。默认值为 `admin` / `change-me-now-123`，
仅适合本机首次启动，登录后应立即在系统设置中修改密码；已有超级管理员时不会覆盖密码。
管理员密码至少 5 位。

后台角色分为 `SUPER_ADMIN` 与 `ADMIN`，两者具有相同业务操作权限。只有
`SUPER_ADMIN` 可以创建 `ADMIN`，并以随机生成或指定密码的方式重置其密码；
`ADMIN` 只能修改自己的密码。后台会话保存在 HttpOnly Cookie 中，浏览器不再持有
运营 Bearer token；会话有效期为 90 天。

系统只生成小红书风格标题、正文和标签，不登录小红书，也不自动发布。系统设置中的“小红书内容生成提示词”保存后对下一次生成生效；每份生成结果记录所用提示词版本。标题、事实引用和 JSON 输出契约由系统固定。草稿可编辑、审核，审核通过后任务完成。图片可选。

“最近活动”读取任务运行事件，包括手动或定时启动、检索、生成、失败及审核结果；管理员登录等审计记录不进入此栏目。

## 本机源码开发

API、Worker 和管理台也可以直接在宿主机运行。前置要求：Node.js >= 20.9、pnpm >= 10。

```bash
# 安装依赖并准备环境变量
pnpm install
cp .env.example .env

# 初始化数据库并构建
pnpm db:migrate
pnpm build && pnpm lint && pnpm typecheck && pnpm test

# 分别启动应用进程（各自终端）
pnpm dev:api
pnpm dev:worker
pnpm dev:console
```

宿主机运行 API 和 Worker 时，按宿主机网络配置 `REDIS_URL`。内容中心的应用令牌、默认上传源与浏览器直传要求见 [接入说明](docs/content-center.md)。
GitHub Actions 生产部署不再需要模型 Provider 的 GitHub Secrets；部署后在管理台系统设置中录入 Provider 与模型。请将数据库文件旁自动生成的加密密钥文件与数据库一起备份，并限制其文件访问权限。

## 规范约束

- 所有代码注释使用中文（见 AGENTS.md）。
- 管理后台禁止使用 Emoji 与任何形式的 SVG 作为界面图标，统一使用
  Font Awesome Free CSS/Webfont（任务 7.2）。
- 敏感凭据一律通过 `@tutor-flow/config/server` 的密钥提供器解析，
  客户端代码只能使用 `@tutor-flow/config/client`。
