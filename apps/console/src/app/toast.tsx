'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@tutor-flow/ui';

export function ToastNotice({
  message,
  tone = 'danger',
}: {
  message?: string | null;
  tone?: 'danger' | 'success' | 'info';
}) {
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    setVisible(Boolean(message));
    if (!message) return;
    const timer = window.setTimeout(() => setVisible(false), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  if (!message || !visible) return null;

  return (
    <div
      className={`toast-notice ${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
    >
      <Icon
        name={tone === 'danger' ? 'warning' : tone === 'success' ? 'check' : 'info'}
      />
      <span>{message}</span>
      <button
        className="icon-button"
        type="button"
        aria-label="关闭提示"
        onClick={() => setVisible(false)}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
