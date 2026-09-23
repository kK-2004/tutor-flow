import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// 在 Linux 容器内执行，使用测试子进程验证真实 Bash 信号和退出行为。
async function fixture(mode) {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-flow-start-'));
  const paths = [
    'packages/db/dist/scripts/migrate.js',
    'apps/api/dist/main.js',
    'apps/worker/dist/main.js',
    'apps/console/node_modules/next/dist/bin/next',
  ];
  for (const [index, path] of paths.entries()) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    const source =
      index === 0
        ? `console.log('迁移完成'); process.exit(${mode === 'migration-fail' ? 7 : 0});`
        : `console.log('就绪:${index}');
         process.on('SIGTERM', () => { console.log('停止:${index}'); process.exit(0); });
         setInterval(() => {}, 1000);
         ${mode === 'crash' && index === 2 ? 'setTimeout(() => process.exit(9), 500);' : ''}`;
    await writeFile(join(dir, path), source);
  }
  const script = (
    await readFile(new URL('../../scripts/start-app.sh', import.meta.url), 'utf8')
  ).replace('cd /app', `cd '${dir}'`);
  const scriptPath = join(dir, 'start.sh');
  await writeFile(scriptPath, script);
  const child = spawn('bash', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    exited,
    output: () => output,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('迁移失败时不启动业务服务并保留失败码', { timeout: 5000 }, async () => {
  const run = await fixture('migration-fail');
  try {
    assert.equal(await run.exited, 7);
    assert.doesNotMatch(run.output(), /就绪:/);
  } finally {
    await run.cleanup();
  }
});

test('业务进程崩溃时停止其余服务并报告失败', { timeout: 5000 }, async () => {
  const run = await fixture('crash');
  try {
    assert.equal(await run.exited, 1);
    assert.match(run.output(), /停止:1/);
    assert.match(run.output(), /停止:3/);
  } finally {
    await run.cleanup();
  }
});

test('收到 SIGTERM 时转发给全部业务进程并正常退出', { timeout: 5000 }, async () => {
  const run = await fixture('normal');
  try {
    for (
      let attempt = 0;
      attempt < 100 && ![1, 2, 3].every((id) => run.output().includes(`就绪:${id}`));
      attempt++
    ) {
      await delay(20);
    }
    for (const id of [1, 2, 3]) assert.match(run.output(), new RegExp(`就绪:${id}`));
    run.child.kill('SIGTERM');
    assert.equal(await run.exited, 0);
    for (const id of [1, 2, 3]) assert.match(run.output(), new RegExp(`停止:${id}`));
  } finally {
    await run.cleanup();
  }
});
