import { readFile } from 'node:fs/promises';

const app = await readFile('apps/console/src/app/console-app.tsx', 'utf8');
const prototype = await readFile('docs/原型.html', 'utf8');
const requiredViews = [
  'overview',
  'workflows',
  'drafts',
  'research',
  'publishes',
  'settings',
];
const missingViews = requiredViews.filter((view) => !app.includes(`'${view}'`));
const requiredPrototypeNav = [
  'dashboard',
  'runs',
  'drafts',
  'sources',
  'publishing',
  'settings',
];
const missingPrototypeNav = requiredPrototypeNav.filter(
  (view) => !prototype.includes(`data-nav="${view}"`),
);
const violations = [];

if (missingViews.length > 0)
  violations.push(`管理台缺少视图：${missingViews.join('、')}`);
if (missingPrototypeNav.length > 0)
  violations.push(`原型导航基线缺少页面：${missingPrototypeNav.join('、')}`);
if (!app.includes("platform: 'xiaohongshu'"))
  violations.push('创建任务未固定为小红书平台');
if (!app.includes('@tutor-flow/ui')) violations.push('管理台未使用共享图标组件');

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('管理台页面覆盖与小红书单平台约束检查通过');
}
