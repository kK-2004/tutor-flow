import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const script = new URL('../../scripts/healthcheck.mjs', import.meta.url).href;
function check(response) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `globalThis.fetch = ${response}; await import(${JSON.stringify(script)});`,
    ],
    { encoding: 'utf8' },
  );
}

test('全部就绪时返回成功且不输出噪音', () => {
  const result = check('async () => Response.json({ status: "ready" })');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('同时报告多个失败服务而不泄露响应正文', () => {
  const result = check(`async (url) => {
    if (url.includes(':3000')) throw new Error('秘密配置', { cause: { code: 'ECONNREFUSED' } });
    if (url.includes(':4100')) return new Response('秘密配置', { status: 503 });
    return Response.json({ status: 'ready' });
  }`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /管理台.*端口尚未监听/);
  assert.match(result.stderr, /Worker.*HTTP 503/);
  assert.doesNotMatch(result.stderr, /秘密配置/);
});

test('HTTP 200 但依赖未就绪时仍判定失败', () => {
  const result = check('async () => Response.json({ status: "degraded" })');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /API.*依赖尚未就绪/);
  assert.match(result.stderr, /Worker.*依赖尚未就绪/);
});
