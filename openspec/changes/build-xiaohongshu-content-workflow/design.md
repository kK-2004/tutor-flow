## 背景

项目当前只有一份单文件离线原型。原型用 `localStorage` 保存任务、草稿、发布记录、设置与主题，用 `setTimeout` 模拟工作流和 SSE，已经定义了主要页面和人工停点，但没有生产后端、数据库、认证、真实搜索、模型调用或平台发布能力。

研究稿要求系统成为可恢复的内容生产流水线，而不是把搜索、生成和浏览器发布串成一次性脚本。首期运行量按低并发设计，目标是每天少于 10 篇；需要允许外部调度器定时调用，允许一次执行跨越人工选题或审核等待，并且在服务重启后恢复。小红书没有在本方案中可依赖的稳定官方发布 API，因此发布属于高风险浏览器自动化路径，必须与 API、研究和内容生成进程隔离。

主要使用者是内容运营人员和系统管理员；外部调用者是受信任的调度器。产品界面以 `docs/原型.html` 为信息架构和交互基线，但数据来源改为服务端。首期只出现并支持小红书，不暴露尚未实现的平台入口。

## 目标与非目标

**目标：**

- 交付从主题输入、检索溯源、方向决策、内容生成、审核到小红书发布回执的完整闭环。
- 让手工创建和外部定时触发共享同一套幂等、持久化、可恢复工作流。
- 为人工选方向、草稿审核、登录失效和不可安全重试的发布结果提供明确停点。
- 保留事实来源、生成配置、内容版本、审批动作、平台请求与回执的审计链。
- 在低并发下保持部署简单，同时通过领域接口为未来替换 Temporal、搜索供应商、模型供应商和发布工具保留边界。
- 严格遵循原型的页面结构，并落实前端不使用 emoji 或 SVG、统一使用图标字体库的约束。

**非目标：**

- 不实现知乎、微信公众号、微博、B 站或通用多平台发布。
- 不提供内置日历式 Cron 编辑器；周期计划由 Nacos、系统 Cron 或其他外部调度器通过受保护接口触发。
- 不绕过验证码、短信验证、风险提示或平台安全机制，也不承诺浏览器自动化具有官方 API 的稳定性。
- 不在首期建设 Temporal 集群、GPU 推理集群、复杂多租户计费或移动端客户端。
- 不把离线原型中的演示数据或 `localStorage` 数据迁移为生产数据。

## 技术决策

### 1. 使用 TypeScript 模块化单仓库与独立执行进程

仓库采用 pnpm workspace，至少包含 `apps/console`（Next.js）、`apps/api`（Fastify）、`apps/worker`（BullMQ workers）和 `packages/domain`、`packages/db`、`packages/integrations`、`packages/ui`。Web、API 和 Worker 共享 TypeScript 领域类型，但分别部署；小红书 MCP/浏览器运行在独立容器或 sidecar 中。

选择 Next.js 是为了复用原型的管理台结构并提供服务端渲染/BFF 能力；选择 Fastify 而不是把长流程放进 Next.js Route Handler，是为了让 API 生命周期、SSE 连接和任务执行边界清晰。备选方案是单个 Next.js 应用或 Spring Boot；前者容易把后台任务绑定到请求生命周期，后者会增加首期跨语言成本。

### 2. SQLite 是事实来源，Redis/BullMQ 只承担调度与临时协调（用户决策：不使用 Docker 部署）

SQLite（单文件、WAL 模式，经 libsql 驱动访问）保存 `content_job`、`workflow_run`、`step_run`、`source_document`、`claim`、`direction_option`、`content_artifact`、`draft_revision`、`platform_account`、`publish_job`、`publish_receipt`、`workflow_event`、`audit_event` 与 `system_setting`。网页正文只作为模型的即时输入，用完即弃，不持久化（用户决策）；数据库保存来源元数据与内容哈希。对象存储（直接接入用户已部署的 MinIO）仅用于 AI 生成图片等媒体资产。SQLite 的单写者模型天然为发布副作用解析提供互斥，替代 PostgreSQL 咨询锁；枚举约束由应用层状态机守卫承担。

Redis/BullMQ 保存待执行队列、延迟重试、账号限流和短期锁，不作为业务状态事实来源（Redis 直接接入用户已部署的实例）。API 在数据库事务内写状态与 outbox 事件，dispatcher 再将工作交给 BullMQ；Worker 必须以数据库状态和幂等键重新校验后才执行。这样可以覆盖“数据库提交成功但入队失败”的窗口。备选方案是只使用 BullMQ job 状态，无法满足审计和恢复要求。

### 3. 用显式状态机驱动可恢复工作流

运行状态采用 `QUEUED`、`RESEARCHING`、`WAITING_DIRECTION`、`GENERATING`、`MODERATING`、`NEEDS_REVIEW`、`READY_TO_PUBLISH`、`PUBLISHING`、`RETRY_WAIT`、`NEEDS_HUMAN`、`SUCCEEDED`、`FAILED`、`CANCELLED`。每一步写入 `step_run` 的输入摘要、输出引用、尝试次数、错误分类和 trace id。

人工模式在 `WAITING_DIRECTION` 或 `NEEDS_REVIEW` 停止派发后续步骤；收到用户动作后从已提交检查点继续。重启时 recovery job 扫描非终态运行，结合最后完成步骤重新派发，所有步骤处理器都必须幂等。首期使用 BullMQ 是因为低并发和运维简单；当长时间工作流数量、并发或跨天等待显著增长时，可在不改变领域状态和 API 契约的前提下迁移到 Temporal。

### 4. 外部调度通过受保护且幂等的运行创建接口接入

管理台和外部调度器都调用 `POST /api/v1/runs`。外部调用必须携带 Bearer token 和 `Idempotency-Key`；请求体包含主题、方向模式、发布模式、账号和唯一平台 `xiaohongshu`。相同调用方与幂等键在保留期内返回原运行，不创建重复任务；载荷冲突返回 `409`。

外部调度系统拥有 Cron 表达式和错过执行策略。本系统只记录 `trigger_type`、`triggered_by`、调度键和期望执行时间，从而减少又一套计划管理界面，同时满足可定时触发要求。

### 5. 检索与生成之间使用可追溯的规范内容模型

Research Worker 先生成带语言和意图的 query plan，再调用可替换的 Search Gateway；首期默认适配 Brave Search。Fetcher 把网页视为不可信数据，执行 URL 归一化、正文抽取（正文仅在研究步骤内即时使用，不持久化）、哈希/近似/语义去重和来源评分。搜索摘要只能用于召回，进入文章的事实必须关联抓取后的 `source_document`。

方向对象保存标题、摘要、受众、关键词、各维度分数和总分。自动模式只选择同时通过来源覆盖、主要来源数量、合规风险和方向分数阈值的最高分方向，否则转 `NEEDS_HUMAN`；人工模式始终等待选择。

内容模型采用一份 `CANONICAL` artifact 和一份 `XIAOHONGSHU` derivative。平台适配只改变表达、标签和媒体编排，不重新检索或发明事实。每个事实保留 source ids，所有 artifact 保存模型、prompt 版本、AIGC 和人工审核元数据。

### 6. 审核、预览和发布是三个不同阶段

`review` 模式生成可编辑草稿并进入 `NEEDS_REVIEW`。草稿以版本号做乐观并发控制，自动保存与手工保存调用相同的 PATCH 接口；服务端先清洗富文本再持久化。批准动作会重新运行事实、敏感信息、平台政策、媒体和 AIGC 标识校验，全部通过后才创建 publish job。

`auto` 模式也不能跳过校验：只有低风险、来源达标、账号策略允许自动发布且平台校验通过时才能直接创建 publish job，其余情况降级到草稿审核或 `NEEDS_HUMAN`。系统默认 `requireHumanApproval=true`，因为小红书使用浏览器自动化。

### 7. 小红书通过隔离的 Publisher Adapter 接入

定义 `checkAuth`、`validate`、`preview`、`publish` 和 `queryStatus` 五个 Publisher Adapter 操作。首选实现用 TypeScript MCP client 调用固定版本和固定镜像摘要的 `xiaohongshu-mcp` sidecar；adapter 之外的领域代码不依赖 MCP 工具名或 DOM 细节。

账号 Cookie、二维码会话和 API 凭据只保存为 Secret Manager/Vault 引用，按发布任务短时挂载到 Publisher Worker。遇到验证码、二次验证、Cookie 失效、异常登录或 selector 失效时立即停止自动尝试并进入 `NEEDS_HUMAN`，绝不实现规避逻辑。

平台限制保存在版本化 `PlatformPolicy` 中，包括标题/正文软硬限制、标签数、媒体数量/格式、是否要求封面、发布方式和审批默认值。默认值来自当前已验证的适配器能力，但运行时可以更新，不写死在 prompt 或 UI。

### 8. 发布采用 effectively-once 防重策略

发布幂等键由 workspace、平台账号、artifact 版本和发布槽位计算。Worker 先取得数据库 advisory lock，再查询 `publish_receipt`：已有回执时只调用 `queryStatus`，没有回执时才允许执行 `publish`。获得平台 post id 或 URL 后必须先写回执，再把 job 标记成功。

网络超时、429 和明确的 5xx 可以指数退避重试；认证失效、验证码、内容违规和 DOM 失效不自动重试；“请求已发出但响应丢失”必须先做平台侧核验，不能盲发。由于小红书没有可依赖的官方幂等键，本设计只声明 effectively-once，不声明 exactly-once。

### 9. REST API 与 SSE 提供稳定的控制面

主要接口如下：

| 方法        | 路径                                          | 用途                        |
| ----------- | --------------------------------------------- | --------------------------- |
| `POST`      | `/api/v1/runs`                                | 手工或外部调度创建运行      |
| `GET`       | `/api/v1/runs`                                | 分页、搜索、筛选运行        |
| `GET`       | `/api/v1/runs/:id`                            | 运行、步骤、方向和统计详情  |
| `GET`       | `/api/v1/runs/:id/events/stream`              | 支持 `Last-Event-ID` 的 SSE |
| `POST`      | `/api/v1/runs/:id/direction-selection`        | 选择方向并恢复              |
| `POST`      | `/api/v1/runs/:id/retry`                      | 重试允许重试的失败步骤      |
| `POST`      | `/api/v1/runs/:id/cancel`                     | 请求取消未终态运行          |
| `GET`       | `/api/v1/runs/:id/sources`                    | 查询研究资料和事实引用      |
| `GET`       | `/api/v1/drafts`                              | 查询待审核草稿              |
| `GET/PATCH` | `/api/v1/drafts/:id`                          | 读取或保存草稿版本          |
| `POST`      | `/api/v1/drafts/:id/approve`                  | 校验并批准发布              |
| `GET`       | `/api/v1/publish-jobs`                        | 查询发布队列与回执          |
| `POST`      | `/api/v1/publish-jobs/:id/retry`              | 重试明确可重试的发布        |
| `GET/PATCH` | `/api/v1/settings`                            | 读取或修改非密钥配置        |
| `POST`      | `/api/v1/xiaohongshu/accounts/:id/check-auth` | 检查账号授权状态            |

所有写接口返回资源版本并写审计事件。SSE 事件先持久化，再以单调 event id 推送；断线客户端用 `Last-Event-ID` 补发，心跳不改变工作流状态。

### 10. 前端复刻产品结构但使用服务端状态

管理台保留原型的侧栏、顶部栏、八类页面/视图、新建任务模态、明暗/跟随系统主题和固定的主色体系。界面图标统一使用 Font Awesome Free CSS/Webfont 包，禁止使用 Font Awesome SVG Core、手写 SVG、内联 SVG、图片型 SVG 和 emoji 充当 UI 图标；纯图标按钮必须有可读名称。

草稿编辑器采用能输出受控 HTML/JSON 的成熟编辑器封装，服务端 sanitization 是最终信任边界。导航和数据读取通过 URL 与服务端 API 驱动，不再把业务数据写入 `localStorage`；`localStorage` 只保存主题等无敏感偏好。

### 11. 安全、合规与可观测性从首期进入数据模型

调度 token、搜索/模型密钥和平台秘密由服务端 secret provider 注入，不通过设置 API 返回。抓取内容不能改变系统提示词或工具权限。发布前执行事实来源、隐私、敏感内容、版权提示、AIGC 标识和平台规则检查；检查结果和人工决定写入审计日志。

所有日志、trace 和 metrics 贯穿 `workflow_run_id`、`step_run_id`、`publish_job_id`、`account_id`、model 与 prompt version，但不得记录正文、Cookie 或密钥。关键指标包括队列等待时间、步骤耗时/失败率、搜索与 token 用量、人工等待时间、发布成功率和账号授权健康度。

## 风险与权衡

- [小红书页面或 MCP 行为变化导致发布中断] → 固定依赖版本，运行 adapter contract/smoke tests，独立容器部署，selector 失效时熔断并转人工。
- [平台成功但本地未收到响应导致重复发布] → advisory lock、稳定幂等键、回执优先落库和“未知结果先核验”策略；接受只能做到 effectively-once。
- [BullMQ 不像 Temporal 那样原生保存长流程历史] → 业务状态完全持久化到 SQLite、步骤幂等、outbox 和 recovery scan；达到迁移阈值后替换调度实现。
- [模型生成无来源事实或被网页 prompt injection 影响] → 网页只作为不可信数据，claim-source 强绑定，发布前验证引用覆盖，未支持事实阻止自动发布。
- [自动发布触发账号风控] → 默认人工审核、账号级串行队列与 token bucket、适度调度 jitter，安全挑战立即停止并要求人工。
- [平台策略变化使旧草稿不再合规] → 保存 policy version，批准与实际发布前均用最新生效策略重新校验。
- [富文本引入 XSS] → 编辑器输出白名单、服务端统一清洗、预览使用受限渲染容器并配置 CSP。
- [单平台设计未来扩展时出现耦合] → 保留 canonical artifact、PlatformPolicy 和 PublisherAdapter 边界，但不提前构建未使用的平台 UI 或适配器。

## 迁移与发布计划

1. 建立 workspace、基础 CI、配置校验，以及 SQLite、Redis（用户已部署）与对象存储（用户已部署 MinIO）的本地开发环境；本项目不通过 Docker 部署任何服务。
2. 创建数据库 schema、迁移、领域状态机、outbox、审计与恢复扫描；用 fake integrations 验证完整工作流。
3. 实现搜索/抓取/LLM gateway 和内容审核链，先在无外部发布副作用的 shadow 模式生成草稿。
4. 实现与原型对应的管理台并切换到真实 API/SSE；离线原型保留在 `docs/原型.html` 作为验收参考。
5. 接入隔离的小红书 MCP adapter，在测试账号上依次验证授权、预览、发布、回执查询和人工恢复。
6. 生产启用时先强制人工审核和单账号串行发布，观察失败分类与风控；稳定后再通过策略配置按账号开放自动发布。

回滚时先禁用 publisher queue 和外部调度 token，保持数据库与草稿只读可查；应用版本可以回退，但数据库迁移采用向前兼容的 expand/contract 方式，不删除审计或回执。任何未知发布结果在回滚期间仍保持 `NEEDS_HUMAN`，不得重新入队。

## 待确认事项

- 生产环境最终使用哪一种 Secret Manager；接口按 `secret_ref` 抽象，开发环境可以使用本地加密 secret provider。
- `xiaohongshu-mcp` 上线时固定的 commit、镜像摘要和已验证平台策略版本，需要在集成测试阶段记录。
- 首期封面/配图来自用户上传、模板渲染还是现有素材库；无论来源如何，没有满足策略的媒体时都必须阻止发布。
- 管理台身份认证由现有网关提供还是项目内接入 OIDC；在确定前，API 仍按“已认证管理员”和独立 scheduler token 两类主体实现授权边界。
