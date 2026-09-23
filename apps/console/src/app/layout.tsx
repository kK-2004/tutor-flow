import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@fortawesome/fontawesome-free/css/all.min.css';
import './styles.css';

/**
 * 根布局：管理后台为中文界面，语言固定为 zh-CN。
 */
export const metadata: Metadata = {
  title: '内容工作台',
  description: '小红书内容研究与发布管理后台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
