import type { HTMLAttributes } from 'react';

/** 已批准的 Font Awesome Free CSS/Webfont 图标名。 */
export type IconName =
  | 'grid'
  | 'workflow'
  | 'draft'
  | 'research'
  | 'publish'
  | 'settings'
  | 'plus'
  | 'sun'
  | 'moon'
  | 'system'
  | 'close'
  | 'save'
  | 'check'
  | 'back'
  | 'eye'
  | 'send'
  | 'info'
  | 'clock'
  | 'warning'
  | 'retry'
  | 'play'
  | 'book'
  | 'filter'
  | 'search';

const ICON_CLASSES: Record<IconName, string> = {
  grid: 'i-grid',
  workflow: 'i-workflow',
  draft: 'i-draft',
  research: 'i-research',
  publish: 'i-publish',
  settings: 'i-settings',
  plus: 'i-plus',
  sun: 'i-sun',
  moon: 'i-moon',
  system: 'i-system',
  close: 'i-close',
  save: 'i-save',
  check: 'i-check',
  back: 'i-back',
  eye: 'i-eye',
  send: 'i-send',
  info: 'i-info',
  clock: 'i-clock',
  warning: 'i-warning',
  retry: 'i-retry',
  play: 'i-play',
  book: 'i-book',
  filter: 'i-filter',
  search: 'i-search',
};

/** 无障碍图标基础组件：装饰图标默认对屏幕阅读器隐藏。 */
export function Icon({
  name,
  label,
  className = '',
  ...props
}: {
  name: IconName;
  label?: string;
  className?: string;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className={`fa ${ICON_CLASSES[name]} ${className}`.trim()}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      role={label === undefined ? undefined : 'img'}
    />
  );
}
