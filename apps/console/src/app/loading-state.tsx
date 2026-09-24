'use client';

export function LoadingState({
  label = '正在加载数据…',
  className = '',
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={`loading-state ${className}`.trim()} role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
