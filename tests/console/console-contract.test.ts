import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../apps/console/src/app');

describe('管理台界面契约', () => {
  it('包含键盘模态框、焦点恢复和中文无障碍名称', async () => {
    const source = await readFile(path.join(root, 'console-app.tsx'), 'utf8');
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('opener.current?.focus()');
    expect(source).toContain('aria-label="关闭"');
    expect(source).toContain('aria-label="全局搜索"');
  });

  it('只保存主题偏好并支持跟随系统变化', async () => {
    const source = await readFile(path.join(root, 'console-app.tsx'), 'utf8');
    const styles = await readFile(path.join(root, 'styles.css'), 'utf8');
    expect(source).toContain("localStorage.setItem('tutor-flow-theme'");
    expect(source).toContain("matchMedia('(prefers-color-scheme: dark)'");
    expect(styles).toContain('@media (max-width: 720px)');
    expect(styles).toContain(':focus-visible');
  });
});
