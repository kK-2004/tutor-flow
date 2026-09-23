// 同时检查管理台、API 数据库及 Worker 队列连接，仅输出安全的诊断信息。
const checks = [
  ['管理台', 'http://127.0.0.1:3000/', false],
  ['API', 'http://127.0.0.1:4000/readyz', true],
  ['Worker', 'http://127.0.0.1:4100/readyz', true],
];
const results = await Promise.allSettled(
  checks.map(async ([name, url, checkStatus]) => {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      if (checkStatus) {
        const body = await response.json();
        if (body.status !== 'ready') throw new Error('依赖尚未就绪');
      } else {
        await response.body?.cancel();
      }
    } catch (error) {
      let reason = '连接失败或响应无效';
      if (error?.name === 'TimeoutError') reason = '检查超时（4 秒）';
      else if (error?.message === '依赖尚未就绪') reason = error.message;
      else if (/^HTTP \d{3}$/.test(error?.message ?? '')) reason = error.message;
      else if (error?.cause?.code === 'ECONNREFUSED') reason = '端口尚未监听';
      // 不输出响应正文或原始异常，避免日志包含配置或凭据。
      throw new Error(`${name} (${url})：${reason}，耗时 ${Date.now() - startedAt}ms`);
    }
  }),
);
for (const result of results) {
  if (result.status === 'rejected') {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
}
