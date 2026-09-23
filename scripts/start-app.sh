#!/bin/bash
set -Eeuo pipefail
cd /app

# 直接启动 Node，避免三个 pnpm 常驻进程额外占用内存。
pids=()
shutdown() {
  trap '' TERM INT
  if ((${#pids[@]})); then
    kill -TERM "${pids[@]}" 2>/dev/null || true
    # 给 Worker 时间结束当前任务，超过期限再强制停止。
    (trap - TERM INT EXIT; sleep 30; kill -KILL "${pids[@]}" 2>/dev/null || true) </dev/null >/dev/null 2>&1 &
    watchdog=$!
    wait "${pids[@]}" 2>/dev/null || true
    kill -KILL "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
}
trap shutdown EXIT
trap 'exit 0' TERM INT

# 迁移失败时不启动任何业务进程；沿用现有命名卷和幂等迁移器。
node --max-old-space-size=128 packages/db/dist/scripts/migrate.js &
pids=($!)
result=0
wait "${pids[0]}" || result=$?
pids=()
if ((result != 0)); then exit "$result"; fi

node --max-old-space-size=96 apps/api/dist/main.js &
pids+=($!)
node --max-old-space-size=128 apps/worker/dist/main.js &
pids+=($!)
node --max-old-space-size=128 apps/console/node_modules/next/dist/bin/next start apps/console --hostname 0.0.0.0 --port 3000 &
pids+=($!)

# 任一业务进程结束都退出容器，由 Docker 统一重启，避免部分服务静默失效。
result=0
wait -n "${pids[@]}" || result=$?
printf '业务进程已退出（状态码 %s），正在停止其余服务\n' "$result" >&2
exit 1
