#!/bin/bash
set -Eeuo pipefail
# 宿主机开发启动脚本：tsx watch / next dev 热重载；容器部署用 start-app.sh。
# 用法：scripts/start-app-dev.sh [--rebuild]（改过 packages 源码后加 --rebuild 重建 dist）
cd "$(dirname "$0")/.."

rebuild=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) rebuild=1 ;;
    *) printf '未知参数：%s（仅支持 --rebuild）\n' "$arg" >&2; exit 2 ;;
  esac
done

# 容器内由 compose 注入环境变量；宿主机开发由脚本自行加载 .env（已导出的变量优先）。
redis_url_override="${REDIS_URL:-}"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
if [[ -n "$redis_url_override" ]]; then REDIS_URL="$redis_url_override"; fi

# .env 里的 host.docker.internal 是给容器连宿主机用的；对宿主机本身等价于 127.0.0.1，直接改写。
if [[ "${REDIS_URL:-}" == *host.docker.internal* ]]; then
  REDIS_URL="${REDIS_URL//host.docker.internal/127.0.0.1}"
  printf '提示：REDIS_URL 已把 host.docker.internal 改写为 127.0.0.1（该域名仅容器内可解析）\n'
fi
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

# 前置探测 Redis，失败直接退出，避免三个业务进程连环崩溃（ioredis 6 为具名导出）。
if ! node --input-type=module -e '
import { Redis } from "ioredis";
const redis = new Redis(process.env.REDIS_URL, {
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null,
});
redis.on("error", () => {});
try {
  const pong = await redis.ping();
  if (pong !== "PONG") throw new Error(`unexpected reply: ${pong}`);
  console.log("Redis 连接正常");
} catch {
  // 报错交给外层 bash 输出友好提示，这里避免打印 ioredis 堆栈。
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
'; then
  printf '无法连接 Redis（%s），请先启动本机 Redis 或修改 .env 后重试\n' "$REDIS_URL" >&2
  exit 1
fi

# tsx 通过 dist 引用工作区包，缺失时构建一次；日常改 packages 源码后用 --rebuild。
if ((rebuild)) || [[ ! -f packages/db/dist/index.js ]]; then
  printf '构建工作区包（packages/**）...\n'
  pnpm --filter './packages/**' build
fi

printf '执行数据库迁移...\n'
pnpm --filter @tutor-flow/db migrate

pids=()
shutdown() {
  trap '' TERM INT
  if ((${#pids[@]})); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    # dev 工具进程对 TERM 响应很快，最多等 10 秒，超时强杀。
    for ((i = 0; i < 40; i++)); do
      (($(jobs -rp | wc -l) == 0)) && break
      sleep 0.25
    done
    kill -KILL "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap shutdown EXIT
trap 'exit 0' TERM INT

printf '启动 API（tsx watch，端口 4000）...\n'
pnpm --filter @tutor-flow/api dev &
pids+=($!)
printf '启动 Worker（tsx watch，健康检查端口 4100）...\n'
pnpm --filter @tutor-flow/worker dev &
pids+=($!)
printf '启动管理台（next dev，端口 3000）...\n'
pnpm --filter @tutor-flow/console dev &
pids+=($!)

printf '全部已启动：管理台 http://127.0.0.1:3000 · API http://127.0.0.1:4000 · Ctrl-C 退出\n'

# macOS 自带 bash 3.2 没有 wait -n，轮询任务表检测任一进程退出。
while :; do
  sleep 1
  if (($(jobs -rp | wc -l) < ${#pids[@]})); then
    printf '有业务进程退出，正在停止其余进程\n' >&2
    exit 1
  fi
done
