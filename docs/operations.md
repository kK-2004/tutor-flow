# 本地设置与发布运维手册

## 本地启动

本项目不使用 Docker 部署服务。准备一份 `.env`，将 `SQLITE_PATH` 指向本地单文件数据库，并填写已经部署好的 Redis 与 MinIO 的连接信息。首次启动前执行：

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
pnpm dev:console
```

API、Worker 和管理台分别运行在环境变量指定的端口。`/healthz` 只表示进程存活，`/readyz` 检查数据库和核心队列依赖；发布 sidecar 不可用时发布器保持禁用，不会影响研究与 API。

## 外部调度器

调度器必须使用服务端配置的 Bearer token，并为每次业务触发提供稳定的 `Idempotency-Key`：

```bash
curl -X POST "$API_BASE/api/v1/runs" \
  -H "Authorization: Bearer $SCHEDULER_TOKEN" \
  -H "Idempotency-Key: daily-post-2026-09-23" \
  -H "Content-Type: application/json" \
  -d '{"topic":"PostgreSQL 17 升级注意事项","directionMode":"manual","publishMode":"review","platform":"xiaohongshu","accountId":"<account-id>"}'
```

相同调用方和幂等键的等价载荷会返回原运行；载荷变化返回 `409`。调度器不能读取运营资料、草稿或 SSE 流。

## 密钥与账号恢复

账号业务记录只保存 `secret_ref`，开发环境引用形如 `env:XHS_ACCOUNT_MAIN`，Cookie 原文只在发布 Worker 调用期间存在于内存。管理台和设置 API 永不返回 Cookie、调度 token、模型 key 或 MinIO secret。

授权失效、扫码、验证码、短信验证和异常登录都会把账号标为人工处理，停止自动重试。运营人员完成平台登录后，先调用账号授权检查，再在管理台执行“恢复人工处理”；恢复后仍建议先运行适配器契约冒烟测试。

## 策略更新

平台策略通过版本化 JSON 保存，批准和实际发布前都会重新读取生效版本。更新策略时必须增加 `policyVersion`，并保留标题、正文、标签、媒体、封面、AIGC、内容类型和审核模式字段；服务端拒绝非法范围以及关闭强制人工批准的请求。

```bash
curl -X PUT "$API_BASE/api/v1/settings/xiaohongshu-policy" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d @policy.json
```

旧草稿不会绕过新策略；策略漂移会把排队任务退回人工处理。

## 未知发布结果

当发布请求超时、响应丢失或回执缺少平台标识时，任务进入 `UNKNOWN_OUTCOME`，禁止点击普通重试。若已经保存回执，先调用：

```bash
curl -X POST "$API_BASE/api/v1/publish-jobs/<job-id>/verify" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

平台侧存在则保存核验状态并完成任务；不存在、被拒绝或查询本身失败都保留人工处理项，不自动再发一篇。

## 熔断与恢复

同一账号连续三次页面选择器或契约错误会打开 30 分钟熔断器。熔断期间任务进入人工处理，不发送后续外部请求。修复 sidecar 版本、选择器或契约后，执行契约测试，确认通过，再恢复账号队列。

## 回滚清单

1. 停止外部调度 token，暂停 publishing 队列。
2. 保持数据库、草稿、审计事件和发布回执只读可查。
3. 未知结果任务保持人工状态，不清空回执也不盲目重新发布。
4. 应用版本回退后先运行数据库兼容检查，再逐步恢复研究、审核和人工批准发布。
