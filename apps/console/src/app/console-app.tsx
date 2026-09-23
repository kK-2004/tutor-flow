'use client';

import { Icon, type IconName } from '@tutor-flow/ui';
import type { ContentCenterMedia, DraftMedia } from '@tutor-flow/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import './styles.css';

type ViewName =
  'overview' | 'workflows' | 'drafts' | 'research' | 'publishes' | 'settings';
type ThemeMode = 'light' | 'dark' | 'system';

interface AdminUser {
  id: string;
  username: string;
  role: 'SUPER_ADMIN' | 'ADMIN';
}

interface LoginQrcode {
  alreadyLoggedIn: boolean;
  qrCodeDataUrl?: string;
  expiresInSeconds: number;
}

interface ApiState {
  loginAccount?: {
    bound: boolean;
    mcpConfigured: boolean;
    account: {
      id: string;
      alias: string;
      health: string;
      lastAuthCheckAt: string | null;
    } | null;
  };
  metrics?: {
    runningRuns: number;
    pendingDrafts: number;
    pendingPublishes: number;
    searchQueries: number;
    tokenUsage: number;
  };
  recentActivity?: Array<{
    id: number;
    occurredAt: string;
    action: string;
    resourceType: string;
    resourceId: string;
  }>;
}

interface RunItem {
  runId: string;
  topic: string;
  status: string;
  directionMode: string;
  publishMode: string;
  platform: string;
  currentStepType?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DraftItem {
  runId: string;
  revision: number;
  status: string;
  title: string;
  topic: string;
  updatedAt: string;
}

interface PublishItem {
  id: string;
  runId: string;
  status: string;
  attempts: number;
  account: { alias: string; health: string };
  content: { revision: number; title: string };
  error?: { category?: string; message?: string } | null;
  receipt?: { platformPostId: string; platformUrl?: string; verification: string } | null;
  updatedAt: string;
}

interface RunDetails extends RunItem {
  cancelRequested: boolean;
  humanGuidance?: string;
  usage?: {
    searchQueries: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  steps: Array<{
    id: string;
    stepType: string;
    attemptNo: number;
    status: string;
    errorCategory?: string | null;
    errorMessage?: string | null;
  }>;
  directions: Array<{
    id: string;
    title: string;
    summary: string;
    targetAudience: string;
    keywords: string[];
    totalScore: number;
    rank: number;
  }>;
  events: Array<{ id: number; name: string; occurredAt: string; payload: unknown }>;
}

interface DraftDetails {
  runId: string;
  revision: number;
  status: string;
  title: string;
  body: string;
  tags: string[];
  mediaObjectKeys: DraftMedia[];
  claimUsages: Array<{ claimId: string; locator: string }>;
  aigcDisclosure: string;
  updatedAt: string;
}

interface SourceData {
  sources: Array<{
    id: string;
    title: string;
    canonicalUrl: string;
    domain: string;
    language: string;
    sourceType: string;
    fetchStatus: string;
    fetchNote?: string | null;
    isPrimary: boolean;
    totalScore?: number | null;
    scoreFactors?: Record<string, number> | null;
    clusterId?: string | null;
    clusterRole?: string | null;
  }>;
  claims: Array<{
    id: string;
    statement: string;
    confidence: number;
    sourceIds: string[];
    usedIn?: unknown;
  }>;
}

interface ContentCenterConfig {
  source: 'minio';
  path: string;
  maxUploadBytes: number;
  downloadExpiresIn: number;
  cdnExpiresIn: number;
}

const API_BASE = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? '';

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function formatTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (['SUCCEEDED', 'VERIFIED', 'HEALTHY', 'FETCHED'].includes(status)) return 'success';
  if (
    [
      'NEEDS_HUMAN',
      'UNKNOWN_OUTCOME',
      'WAITING_DIRECTION',
      'NEEDS_REVIEW',
      'PUBLISHING',
    ].includes(status)
  )
    return 'warning';
  if (['FAILED', 'AUTH_REQUIRED', 'CHALLENGE_REQUIRED', 'REJECTED'].includes(status))
    return 'danger';
  return 'neutral';
}

function Status({ value }: { value: string }) {
  return <span className={`status ${statusTone(value)}`}>{value}</span>;
}

function viewFromLocation(): { view: ViewName; id?: string } {
  if (typeof window === 'undefined') return { view: 'overview' };
  const query = new URLSearchParams(window.location.search);
  const value = query.get('view') ?? 'overview';
  if (value.startsWith('workflow/'))
    return { view: 'workflows', id: value.slice('workflow/'.length) };
  if (value.startsWith('draft/'))
    return { view: 'drafts', id: value.slice('draft/'.length) };
  if (
    ['overview', 'workflows', 'drafts', 'research', 'publishes', 'settings'].includes(
      value,
    )
  )
    return { view: value as ViewName };
  return { view: 'overview' };
}

function navigate(value: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', `/?view=${encodeURIComponent(value)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(
      payload?.error ?? `请求失败（${response.status}）`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

function useTheme(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>('system');
  useEffect(() => {
    const saved = window.localStorage.getItem('tutor-flow-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') setMode(saved);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        mode === 'dark' ||
        (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset['theme'] = dark ? 'dark' : 'light';
    };
    apply();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode]);
  const update = (next: ThemeMode) => {
    setMode(next);
    window.localStorage.setItem('tutor-flow-theme', next);
  };
  return [mode, update];
}

function ThemePicker({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  const options: Array<[ThemeMode, IconName, string]> = [
    ['light', 'sun', '浅色'],
    ['dark', 'moon', '深色'],
    ['system', 'system', '跟随系统'],
  ];
  return (
    <div className="theme-picker" aria-label="主题选择">
      {options.map(([value, icon, label]) => (
        <button
          key={value}
          className={mode === value ? 'active' : ''}
          aria-label={label}
          title={label}
          onClick={() => onChange(value)}
        >
          <Icon name={icon} />
        </button>
      ))}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = ref.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex="0"]',
    );
    focusable?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab' || ref.current === null) return;
      const items = [
        ...ref.current.querySelectorAll<HTMLElement>(
          'input, select, textarea, button, [tabindex="0"]',
        ),
      ].filter((item) => !item.hasAttribute('disabled'));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener.current?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <div className="modal-header">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}

const navItems: Array<{ view: string; label: string; icon: IconName }> = [
  { view: 'overview', label: '概览', icon: 'grid' },
  { view: 'workflows', label: '工作流', icon: 'workflow' },
  { view: 'drafts', label: '草稿箱', icon: 'draft' },
  { view: 'research', label: '研究资料', icon: 'research' },
  { view: 'publishes', label: '发布管理', icon: 'publish' },
  { view: 'settings', label: '系统设置', icon: 'settings' },
];

function Shell({
  active,
  mode,
  onTheme,
  children,
  onCreate,
  user,
  onLogout,
}: {
  active: ViewName;
  mode: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  children: React.ReactNode;
  onCreate: () => void;
  user: AdminUser;
  onLogout: () => void;
}) {
  const title = navItems.find((item) => item.view === active)?.label ?? '概览';
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="grid" />
          </span>
          <span>
            内容工作台<span className="brand-subtitle">研究 · 审核 · 发布</span>
          </span>
        </div>
        <div className="nav-section">工作台</div>
        <nav className="nav-list" aria-label="主导航">
          {navItems.map((item) => (
            <a
              key={item.view}
              className={`nav-item ${active === item.view ? 'active' : ''}`}
              href={`/?view=${item.view}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(item.view);
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">小红书单平台 · 服务端数据</div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>工作台</span>
            <span>/</span>
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <label className="search">
              <Icon name="search" />
              <input aria-label="全局搜索" placeholder="搜索任务、草稿…" />
            </label>
            <ThemePicker mode={mode} onChange={onTheme} />
            <button className="user-menu" onClick={onLogout} title="退出登录">
              <strong>{user.username}</strong>
              <span>{user.role === 'SUPER_ADMIN' ? '超级管理员' : '管理员'}</span>
            </button>
            <button className="button primary" onClick={onCreate}>
              <Icon name="plus" />
              新建任务
            </button>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}

function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function OverviewView({
  data,
  onRefresh,
  onLogin,
}: {
  data?: ApiState;
  onRefresh: () => void;
  onLogin: () => void;
}) {
  const loginAccount = data?.loginAccount;
  const account = loginAccount?.account;
  const health = account?.health;
  const loginState =
    health === 'HEALTHY'
      ? { label: '登录正常', tone: 'success' }
      : health === 'AUTH_REQUIRED'
        ? { label: '需要重新登录', tone: 'danger' }
        : health === 'CHALLENGE_REQUIRED'
          ? { label: '需要完成验证', tone: 'warning' }
          : health === 'DISABLED'
            ? { label: '账号已停用', tone: 'neutral' }
            : account
              ? { label: '待检查', tone: 'neutral' }
              : { label: '未绑定', tone: 'neutral' };
  const metrics = data?.metrics ?? {
    runningRuns: 0,
    pendingDrafts: 0,
    pendingPublishes: 0,
    searchQueries: 0,
    tokenUsage: 0,
  };
  const cards = [
    ['执行中任务', metrics.runningRuns, '服务端实时统计'],
    ['待审核草稿', metrics.pendingDrafts, '需要运营处理'],
    ['发布队列', metrics.pendingPublishes, '含失败与人工处理'],
    ['搜索查询', metrics.searchQueries, '当前工作空间累计'],
    ['模型 Token', metrics.tokenUsage, '已记录用量'],
  ];
  return (
    <div className="content">
      <PageHeading
        title="概览"
        description="查看内容生产链路的实时状态与最近活动。"
        action={
          <button className="button" onClick={onRefresh}>
            <Icon name="retry" />
            刷新数据
          </button>
        }
      />
      <div className="metrics">
        {cards.map(([label, value, note]) => (
          <div className="metric" key={String(label)}>
            <div className="metric-label">{label}</div>
            <div className="metric-value">{Number(value).toLocaleString('zh-CN')}</div>
            <div className="metric-note">{note}</div>
          </div>
        ))}
      </div>
      <section className="card login-account-card">
        <div className="card-heading">
          <h2>登录账号</h2>
          <span>小红书 MCP 唯一绑定账号</span>
        </div>
        <button
          type="button"
          className="login-account-content login-account-trigger"
          onClick={onLogin}
        >
          <div className="login-account-primary">
            <div className="login-account-icon">
              <Icon name="publish" />
            </div>
            <div>
              <div className="metric-label">当前发布账号</div>
              <strong className="login-account-name">
                {account?.alias ??
                  (loginAccount?.bound ? '绑定账号未注册' : '尚未绑定登录账号')}
              </strong>
              <div className="login-account-note">
                {account
                  ? '使用上游 MCP 容器内持久化的登录会话'
                  : loginAccount?.bound
                    ? '请检查 MCP 绑定的账号 ID 是否存在于平台账号列表'
                    : '配置唯一绑定账号后，可在此查看登录健康状态'}
              </div>
            </div>
          </div>
          <div className="login-account-field">
            <span>登录状态</span>
            <span className={`status ${loginState.tone}`}>{loginState.label}</span>
          </div>
          <div className="login-account-field">
            <span>MCP 接入</span>
            <strong>{loginAccount?.mcpConfigured ? '地址已配置' : '未配置'}</strong>
          </div>
          <div className="login-account-field">
            <span>最近认证检查</span>
            <strong>
              {account?.lastAuthCheckAt
                ? formatTime(account.lastAuthCheckAt)
                : '尚未检查'}
            </strong>
          </div>
          <span className="login-account-action">
            {health === 'HEALTHY' ? '查看登录状态' : '点击扫码登录'}
          </span>
        </button>
      </section>
      <div className="grid-two">
        <section className="card">
          <div className="card-heading">
            <h2>最近活动</h2>
            <span>服务端审计事件</span>
          </div>
          <div className="card-body">
            {data?.recentActivity?.length ? (
              <div className="timeline">
                {data.recentActivity.map((item) => (
                  <div className="timeline-item" key={item.id}>
                    <strong>
                      {item.action} · {item.resourceType}
                    </strong>
                    <span>
                      {formatTime(item.occurredAt)} · {item.resourceId}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty">
                <Icon name="clock" />
                暂无活动数据
              </div>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>运行提示</h2>
            <span>安全停点</span>
          </div>
          <div className="card-body">
            <div className="alert">
              <Icon name="info" />
              <span>
                小红书发布默认需要人工批准；结果未知的任务必须先核验，系统不会盲目重发。
              </span>
            </div>
            <p className="muted small">
              研究正文只在研究步骤内即时使用，数据库保留来源元数据、事实关系和审计链。
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function WorkflowsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<RunItem[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => {
    void api<{ items: RunItem[] }>('/api/v1/runs')
      .then((value) => {
        setItems(value.items);
        setError('');
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '运行任务加载失败'),
      );
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (status === '' || item.status === status) &&
          item.topic.toLowerCase().includes(query.toLowerCase()),
      ),
    [items, query, status],
  );
  return (
    <div className="content">
      <PageHeading title="工作流" description="搜索、筛选和处理可恢复的内容生产任务。" />
      <div className="toolbar">
        <label className="search">
          <Icon name="search" />
          <input
            aria-label="搜索主题"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索主题"
          />
        </label>
        <select
          className="select"
          aria-label="状态筛选"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="RESEARCHING">研究中</option>
          <option value="WAITING_DIRECTION">等待选向</option>
          <option value="NEEDS_REVIEW">待审核</option>
          <option value="PUBLISHING">发布中</option>
          <option value="SUCCEEDED">已完成</option>
          <option value="NEEDS_HUMAN">需人工处理</option>
        </select>
        <button className="button" onClick={load}>
          <Icon name="filter" />
          应用筛选
        </button>
      </div>
      {error ? (
        <div className="alert">
          <Icon name="warning" />
          {error}
        </div>
      ) : null}
      <div className="run-list">
        {filtered.map((item) => (
          <button className="run-row" key={item.runId} onClick={() => onOpen(item.runId)}>
            <span className="run-topic">
              <strong>{item.topic}</strong>
              <span>
                {item.runId} · {item.platform}
              </span>
            </span>
            <Status value={item.status} />
            <span className="muted">
              {item.directionMode === 'manual' ? '人工选向' : '自动选向'}
            </span>
            <span className="muted">{formatTime(item.updatedAt)}</span>
            <span className="button compact">查看详情</span>
          </button>
        ))}
        {filtered.length === 0 ? (
          <div className="card empty">
            <Icon name="workflow" />
            暂无符合条件的工作流
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkflowDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<RunDetails | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const load = useCallback(() => {
    void api<RunDetails>(`/api/v1/runs/${id}`)
      .then(setDetail)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '任务加载失败'),
      );
  }, [id]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  const choose = () => {
    if (!selected) return;
    void api(`/api/v1/runs/${id}/direction-selection`, {
      method: 'POST',
      body: JSON.stringify({ directionId: selected }),
    })
      .then(load)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '选择方向失败'),
      );
  };
  const cancel = () => {
    void api(`/api/v1/runs/${id}/cancel`, { method: 'POST', body: '{}' })
      .then(load)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '取消失败'),
      );
  };
  const retry = () => {
    void api(`/api/v1/runs/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({ reason: '管理台安全重试' }),
    })
      .then(load)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '重试失败'),
      );
  };
  if (detail === null)
    return (
      <div className="content">
        <button className="button" onClick={onBack}>
          <Icon name="back" />
          返回工作流
        </button>
        <div className="card empty">{error || '正在加载任务…'}</div>
      </div>
    );
  return (
    <div className="content">
      <PageHeading
        title={detail.topic}
        description={`${detail.runId} · ${detail.platform} · 更新时间 ${formatTime(detail.updatedAt)}`}
        action={
          <div className="actions">
            <button className="button" onClick={onBack}>
              <Icon name="back" />
              返回
            </button>
            {detail.status === 'FAILED' ? (
              <button className="button" onClick={retry}>
                <Icon name="retry" />
                安全重试
              </button>
            ) : null}
            {!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.status) ? (
              <button className="button danger" onClick={cancel}>
                取消运行
              </button>
            ) : null}
          </div>
        }
      />
      <div className="detail-grid">
        <section className="card">
          <div className="card-heading">
            <h2>执行步骤</h2>
            <Status value={detail.status} />
          </div>
          <div className="card-body">
            <div className="steps">
              {detail.steps.map((step) => (
                <div
                  className={`step ${step.status === 'SUCCEEDED' ? 'done' : ''}`}
                  key={step.id}
                >
                  <span className="step-dot">
                    {step.status === 'SUCCEEDED' ? (
                      <Icon name="check" />
                    ) : (
                      <Icon name="clock" />
                    )}
                  </span>
                  <div>
                    <div className="step-name">{step.stepType}</div>
                    <div className="step-note">
                      尝试 {step.attemptNo}
                      {step.errorMessage
                        ? ` · ${step.errorCategory ?? '错误'}：${step.errorMessage}`
                        : ''}
                    </div>
                  </div>
                  <Status value={step.status} />
                </div>
              ))}
              {detail.steps.length === 0 ? (
                <div className="empty">步骤尚未落库</div>
              ) : null}
            </div>
            {detail.usage ? (
              <div className="usage-grid">
                <span>搜索 {detail.usage.searchQueries}</span>
                <span>Token {detail.usage.totalTokens}</span>
                <span>提示词 {detail.usage.promptTokens}</span>
                <span>输出 {detail.usage.completionTokens}</span>
              </div>
            ) : null}
          </div>
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>人工操作</h2>
            <span>仅在停点显示</span>
          </div>
          <div className="card-body">
            {detail.humanGuidance ? (
              <div className="alert">
                <Icon name="info" />
                <span>{detail.humanGuidance}</span>
              </div>
            ) : null}
            {detail.status === 'WAITING_DIRECTION' ? (
              <>
                <p className="muted">请选择一个候选方向，选择后将继续生成。</p>
                <div className="direction-grid">
                  {detail.directions.map((direction) => (
                    <button
                      className={`direction-card ${selected === direction.id ? 'selected' : ''}`}
                      key={direction.id}
                      onClick={() => setSelected(direction.id)}
                    >
                      <h3>{direction.title}</h3>
                      <p>{direction.summary}</p>
                      <span className="score">{direction.totalScore.toFixed(1)} 分</span>
                    </button>
                  ))}
                </div>
                <button className="button primary" disabled={!selected} onClick={choose}>
                  确认方向
                </button>
              </>
            ) : (
              <div className="empty">
                <Icon name="info" />
                当前没有需要人工选择的停点
              </div>
            )}
          </div>
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-heading">
          <h2>持久化事件</h2>
          <span>{detail.events.length} 条 · SSE 支持断线重放</span>
        </div>
        <div className="card-body">
          <div className="timeline">
            {detail.events.map((event) => (
              <div className="timeline-item" key={event.id}>
                <strong>{event.name}</strong>
                <span>
                  {formatTime(event.occurredAt)} · event {event.id}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
      {error ? (
        <div className="alert" style={{ marginTop: 16 }}>
          <Icon name="warning" />
          {error}
        </div>
      ) : null}
    </div>
  );
}

function DraftsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<DraftItem[]>([]);
  const [status, setStatus] = useState('PENDING_REVIEW');
  const load = useCallback(() => {
    void api<{ items: DraftItem[] }>(`/api/v1/drafts?status=${status}`)
      .then((value) => setItems(value.items))
      .catch(() => setItems([]));
  }, [status]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="content">
      <PageHeading
        title="草稿箱"
        description="编辑、预览并批准需要人工审核的小红书内容。"
      />
      <div className="toolbar">
        <select
          className="select"
          aria-label="草稿状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="PENDING_REVIEW">待审核</option>
          <option value="APPROVED">已批准</option>
          <option value="SUPERSEDED">已替代</option>
        </select>
        <button className="button" onClick={load}>
          <Icon name="retry" />
          刷新
        </button>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>标题</th>
                <th>主题</th>
                <th>修订</th>
                <th>状态</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.runId}>
                  <td>
                    <strong>{item.title}</strong>
                  </td>
                  <td>{item.topic}</td>
                  <td>v{item.revision}</td>
                  <td>
                    <Status value={item.status} />
                  </td>
                  <td>{formatTime(item.updatedAt)}</td>
                  <td>
                    <button className="button compact" onClick={() => onOpen(item.runId)}>
                      <Icon name="eye" />
                      打开
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 ? (
            <div className="empty">
              <Icon name="draft" />
              暂无草稿
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DraftEditorView({ id, onBack }: { id: string; onBack: () => void }) {
  const [draft, setDraft] = useState<DraftDetails | null>(null);
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const load = useCallback(() => {
    void api<DraftDetails>(`/api/v1/drafts/${id}`)
      .then((value) => {
        setDraft(value);
        setDirty(false);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '草稿加载失败'),
      );
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);
  const save = useCallback(
    (silent = false) => {
      if (draft === null) return;
      if (!silent) setState('保存中');
      void api(`/api/v1/drafts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevision: draft.revision,
          title: draft.title,
          body: draft.body,
          tags: draft.tags,
          mediaObjectKeys: draft.mediaObjectKeys,
          aigcDisclosure: draft.aigcDisclosure,
        }),
      })
        .then(() => {
          setDirty(false);
          setState(silent ? '已自动保存' : '已保存');
          load();
        })
        .catch((reason: unknown) => {
          setState('存在冲突');
          setError(
            reason instanceof Error ? reason.message : '保存失败，请刷新恢复最新修订',
          );
        });
    },
    [draft, id, load],
  );
  useEffect(() => {
    if (!dirty || draft === null) return;
    const timer = window.setTimeout(() => save(true), 900);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, save]);
  const approve = () => {
    if (draft === null) return;
    void api(`/api/v1/drafts/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: draft.revision }),
    })
      .then(() => {
        setState('已批准，发布任务已创建');
        load();
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '批准失败'),
      );
  };
  const uploadImage = async (file: File) => {
    if (draft === null) return;
    setUploading(true);
    setError('');
    setState('正在上传图片');
    try {
      const init = await api<{
        putUrl: string;
        storageKey: string;
        source: string;
      }>('/api/v1/media/uploads/init', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });
      const put = await fetch(init.putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!put.ok) throw new Error(`图片直传失败（${put.status}）`);
      const result = await api<{ media: ContentCenterMedia }>(
        '/api/v1/media/uploads/complete',
        {
          method: 'POST',
          body: JSON.stringify({ storageKey: init.storageKey, source: init.source }),
        },
      );
      setDraft((current) =>
        current === null
          ? current
          : {
              ...current,
              mediaObjectKeys: [...current.mediaObjectKeys, result.media],
            },
      );
      setDirty(true);
      setState('图片已上传，正在保存草稿');
    } catch (reason) {
      setState('图片上传失败');
      setError(reason instanceof Error ? reason.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  };
  const openImage = async (media: DraftMedia) => {
    if (typeof media === 'string') return;
    try {
      const link = await api<{ url: string }>(`/api/v1/media/${media.fileId}/cdn-link`);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法获取图片预览链接');
    }
  };
  if (draft === null)
    return (
      <div className="content">
        <button className="button" onClick={onBack}>
          <Icon name="back" />
          返回草稿箱
        </button>
        <div className="card empty">{error || '正在加载草稿…'}</div>
      </div>
    );
  return (
    <div className="content">
      <PageHeading
        title="草稿编辑"
        description={`${draft.runId} · 当前修订 v${draft.revision}`}
        action={
          <div className="actions">
            <button className="button" onClick={onBack}>
              <Icon name="back" />
              返回
            </button>
            <button className="button" onClick={() => save()}>
              <Icon name="save" />
              保存
            </button>
            <button className="button primary" onClick={approve}>
              <Icon name="check" />
              批准并发布
            </button>
          </div>
        }
      />
      <div className="detail-grid">
        <section className="card">
          <div className="card-heading">
            <h2>编辑内容</h2>
            <span aria-live="polite">{state || (dirty ? '未保存' : '已加载')}</span>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <div className="form-field full">
                <label htmlFor="draft-title">标题</label>
                <input
                  id="draft-title"
                  value={draft.title}
                  onChange={(event) => {
                    setDraft({ ...draft, title: event.target.value });
                    setDirty(true);
                  }}
                />
              </div>
              <div className="form-field full">
                <label htmlFor="draft-body">正文</label>
                <textarea
                  id="draft-body"
                  value={draft.body}
                  onChange={(event) => {
                    setDraft({ ...draft, body: event.target.value });
                    setDirty(true);
                  }}
                />
              </div>
              <div className="form-field">
                <label htmlFor="draft-tags">标签（每行一个）</label>
                <textarea
                  id="draft-tags"
                  value={draft.tags.join('\n')}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      tags: event.target.value
                        .split('\n')
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    });
                    setDirty(true);
                  }}
                />
              </div>
              <div className="form-field">
                <label htmlFor="draft-aigc">AIGC 标识</label>
                <select
                  id="draft-aigc"
                  value={draft.aigcDisclosure}
                  onChange={(event) => {
                    setDraft({ ...draft, aigcDisclosure: event.target.value });
                    setDirty(true);
                  }}
                >
                  <option value="disclosed">已标识</option>
                  <option value="undisclosed">未标识</option>
                </select>
              </div>
              <div className="form-field full">
                <label htmlFor="draft-image">内容中心图片</label>
                <input
                  id="draft-image"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploading || draft.mediaObjectKeys.length >= 30}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadImage(file);
                    event.target.value = '';
                  }}
                />
                <span className="small muted">
                  {uploading ? '上传中…' : '通过内容中心预签名地址直传 MinIO，最多 30 张'}
                </span>
                {draft.mediaObjectKeys.map((media, index) => (
                  <div
                    className="setting-row"
                    key={`${typeof media === 'string' ? media : media.fileId}-${index}`}
                  >
                    <span className="setting-value">
                      {typeof media === 'string'
                        ? media
                        : `${media.name} (#${media.fileId})`}
                    </span>
                    {typeof media !== 'string' ? (
                      <button
                        className="button compact"
                        onClick={() => void openImage(media)}
                      >
                        预览
                      </button>
                    ) : null}
                    <button
                      className="button compact"
                      onClick={() => {
                        setDraft({
                          ...draft,
                          mediaObjectKeys: draft.mediaObjectKeys.filter(
                            (_, at) => at !== index,
                          ),
                        });
                        setDirty(true);
                      }}
                    >
                      移除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>小红书实际预览</h2>
            <span>以持久化内容为准</span>
          </div>
          <div className="card-body">
            <h2>{draft.title || '未填写标题'}</h2>
            <div className="prose">{draft.body || '未填写正文'}</div>
            <p className="muted small">
              标签：{draft.tags.map((tag) => `#${tag}`).join(' ') || '无'}
            </p>
            <p className="muted small">
              媒体：{draft.mediaObjectKeys.length} 项 · AIGC：
              {draft.aigcDisclosure === 'disclosed' ? '已标识' : '未标识'}
            </p>
          </div>
        </section>
      </div>
      {error ? (
        <div className="alert" style={{ marginTop: 16 }}>
          <Icon name="warning" />
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ResearchView() {
  const [runId, setRunId] = useState('');
  const [data, setData] = useState<SourceData | null>(null);
  const load = () => {
    if (!runId) return;
    void api<SourceData>(`/api/v1/runs/${runId}/sources`)
      .then(setData)
      .catch(() => setData(null));
  };
  return (
    <div className="content">
      <PageHeading
        title="研究资料"
        description="检查来源评分、重复聚类、抓取状态与事实引用位置。"
      />
      <div className="toolbar">
        <input
          className="field"
          aria-label="运行任务 ID"
          value={runId}
          onChange={(event) => setRunId(event.target.value)}
          placeholder="输入运行任务 ID"
        />
        <button className="button primary" onClick={load}>
          <Icon name="search" />
          加载来源
        </button>
      </div>
      {data ? (
        <>
          <div className="source-grid">
            {data.sources.map((source) => (
              <article className="source-card" key={source.id}>
                <h3>{source.title}</h3>
                <p>
                  {source.domain} · {source.language} · {source.sourceType}
                </p>
                <p>
                  <a href={source.canonicalUrl} target="_blank" rel="noreferrer">
                    {source.canonicalUrl}
                  </a>
                </p>
                <div className="source-meta">
                  <Status value={source.fetchStatus} />
                  <span>{source.isPrimary ? '主要来源' : '辅助来源'}</span>
                  <span>评分 {source.totalScore?.toFixed(1) ?? '—'}</span>
                  {source.clusterId ? (
                    <span>重复聚类：{source.clusterRole ?? '成员'}</span>
                  ) : null}
                </div>
                {source.fetchNote ? (
                  <p className="muted small">{source.fetchNote}</p>
                ) : null}
                {source.scoreFactors ? (
                  <div className="factor-list">
                    {Object.entries(source.scoreFactors).map(([key, value]) => (
                      <span key={key}>
                        {key} {Number(value).toFixed(2)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
          <section className="card" style={{ marginTop: 16 }}>
            <div className="card-heading">
              <h2>事实引用</h2>
              <span>{data.claims.length} 条</span>
            </div>
            <div className="card-body">
              {data.claims.map((claim) => (
                <div className="setting-row" key={claim.id}>
                  <span className="setting-key">
                    置信度 {Math.round(claim.confidence * 100)}%
                  </span>
                  <span>{claim.statement}</span>
                  <span className="small muted">
                    {claim.sourceIds.length} 个来源
                    {claim.usedIn ? ` · 使用位置 ${JSON.stringify(claim.usedIn)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <div className="card empty">
          <Icon name="book" />
          输入运行任务 ID 查看研究链路
        </div>
      )}
    </div>
  );
}

function PublishesView() {
  const [items, setItems] = useState<PublishItem[]>([]);
  const [status, setStatus] = useState('');
  const load = useCallback(() => {
    const suffix = status ? `?status=${status}` : '';
    void api<{ items: PublishItem[] }>(`/api/v1/publish-jobs${suffix}`)
      .then((value) => setItems(value.items))
      .catch(() => setItems([]));
  }, [status]);
  useEffect(() => {
    load();
  }, [load]);
  const retry = (id: string) => {
    void api(`/api/v1/publish-jobs/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({ reason: '管理台手工重试' }),
    })
      .then(load)
      .catch(() => undefined);
  };
  const verify = (id: string) => {
    void api(`/api/v1/publish-jobs/${id}/verify`, { method: 'POST', body: '{}' })
      .then(load)
      .catch(() => undefined);
  };
  const stats = {
    queued: items.filter((item) => ['QUEUED', 'PUBLISHING'].includes(item.status)).length,
    succeeded: items.filter((item) => item.status === 'SUCCEEDED').length,
    needsHuman: items.filter((item) =>
      ['UNKNOWN_OUTCOME', 'NEEDS_HUMAN'].includes(item.status),
    ).length,
    attempts: items.reduce((total, item) => total + item.attempts, 0),
  };
  return (
    <div className="content">
      <PageHeading
        title="发布管理"
        description="查看账号队列、发布回执、核验状态和人工处理项。"
      />
      <div className="metrics metrics-compact">
        <div className="metric">
          <div className="metric-label">排队中</div>
          <div className="metric-value">{stats.queued}</div>
        </div>
        <div className="metric">
          <div className="metric-label">已成功</div>
          <div className="metric-value">{stats.succeeded}</div>
        </div>
        <div className="metric">
          <div className="metric-label">需人工</div>
          <div className="metric-value">{stats.needsHuman}</div>
        </div>
        <div className="metric">
          <div className="metric-label">累计尝试</div>
          <div className="metric-value">{stats.attempts}</div>
        </div>
      </div>
      <div className="toolbar">
        <select
          className="select"
          aria-label="发布状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="QUEUED">排队中</option>
          <option value="PUBLISHING">发布中</option>
          <option value="SUCCEEDED">已成功</option>
          <option value="FAILED">失败</option>
          <option value="UNKNOWN_OUTCOME">结果未知</option>
          <option value="NEEDS_HUMAN">需人工处理</option>
        </select>
        <button className="button" onClick={load}>
          <Icon name="retry" />
          刷新
        </button>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>内容</th>
                <th>账号</th>
                <th>状态</th>
                <th>尝试</th>
                <th>回执</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.content.title}</strong>
                    <div className="small muted">{item.id}</div>
                  </td>
                  <td>{item.account.alias}</td>
                  <td>
                    <Status value={item.status} />
                  </td>
                  <td>{item.attempts}</td>
                  <td>{item.receipt?.platformPostId ?? item.error?.category ?? '—'}</td>
                  <td>{formatTime(item.updatedAt)}</td>
                  <td>
                    <div className="actions">
                      {item.status === 'FAILED' ? (
                        <button className="button compact" onClick={() => retry(item.id)}>
                          <Icon name="retry" />
                          重试
                        </button>
                      ) : null}
                      {['UNKNOWN_OUTCOME', 'NEEDS_HUMAN'].includes(item.status) &&
                      item.receipt ? (
                        <button
                          className="button compact"
                          onClick={() => verify(item.id)}
                        >
                          <Icon name="check" />
                          核验
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 ? (
            <div className="empty">
              <Icon name="publish" />
              暂无发布任务
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SettingsView({ user }: { user: AdminUser }) {
  type SettingItem = { key: string; value: unknown; version: number };
  type SettingsData = {
    items: SettingItem[];
    policy: { version: string };
    connections: Record<string, string>;
    secrets?: Record<string, string>;
  };
  const [data, setData] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState('');
  const [accountMessage, setAccountMessage] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newAdminUsername, setNewAdminUsername] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [admins, setAdmins] = useState<
    Array<AdminUser & { createdAt: string; updatedAt: string }>
  >([]);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetMode, setResetMode] = useState<'random' | 'specified'>('random');
  const [resetPassword, setResetPassword] = useState('');
  const [maxQueries, setMaxQueries] = useState(5);
  const [minDirectionScore, setMinDirectionScore] = useState(60);
  const [contentCenter, setContentCenter] = useState<ContentCenterConfig>({
    source: 'minio',
    path: 'tutor-flow',
    maxUploadBytes: 20 * 1024 * 1024,
    downloadExpiresIn: 300,
    cdnExpiresIn: 0,
  });
  useEffect(() => {
    void api<SettingsData>('/api/v1/settings')
      .then((value) => {
        setData(value);
        const budget = value.items.find((item) => item.key === 'search_budget')?.value as
          { maxQueries?: number } | undefined;
        const quality = value.items.find((item) => item.key === 'quality_thresholds')
          ?.value as { minDirectionScore?: number } | undefined;
        setMaxQueries(budget?.maxQueries ?? 5);
        setMinDirectionScore(quality?.minDirectionScore ?? 60);
        const content = value.items.find((item) => item.key === 'content_center')
          ?.value as ContentCenterConfig | undefined;
        if (content) setContentCenter(content);
      })
      .catch(() => setData(null));
  }, []);
  const loadAdmins = useCallback(() => {
    if (user.role !== 'SUPER_ADMIN') return;
    void api<{ items: Array<AdminUser & { createdAt: string; updatedAt: string }> }>(
      '/api/v1/admin/users',
    )
      .then((value) => setAdmins(value.items))
      .catch(() => setAdmins([]));
  }, [user.role]);
  useEffect(() => loadAdmins(), [loadAdmins]);
  const changeOwnPassword = () => {
    setAccountMessage('');
    void api('/api/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
      .then(() => {
        setCurrentPassword('');
        setNewPassword('');
        setAccountMessage('密码已修改，其他登录会话已失效');
      })
      .catch((reason: unknown) =>
        setAccountMessage(reason instanceof Error ? reason.message : '密码修改失败'),
      );
  };
  const createAdmin = () => {
    setAccountMessage('');
    void api('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: newAdminUsername, password: newAdminPassword }),
    })
      .then(() => {
        setNewAdminUsername('');
        setNewAdminPassword('');
        setAccountMessage('ADMIN 已创建');
        loadAdmins();
      })
      .catch((reason: unknown) =>
        setAccountMessage(reason instanceof Error ? reason.message : '管理员创建失败'),
      );
  };
  const resetAdminPassword = () => {
    if (resetTarget === null) return;
    setAccountMessage('');
    void api<{ password?: string }>(
      `/api/v1/admin/users/${resetTarget.id}/reset-password`,
      {
        method: 'POST',
        body: JSON.stringify(
          resetMode === 'random'
            ? { mode: 'random' }
            : { mode: 'specified', password: resetPassword },
        ),
      },
    )
      .then((value) => {
        setAccountMessage(
          value.password
            ? `已重置 ${resetTarget.username} 的密码，一次性新密码：${value.password}`
            : `已重置 ${resetTarget.username} 的密码`,
        );
        setResetTarget(null);
        setResetPassword('');
      })
      .catch((reason: unknown) =>
        setAccountMessage(reason instanceof Error ? reason.message : '密码重置失败'),
      );
  };
  const updateSetting = (key: string, value: unknown) => {
    const item = data?.items.find((candidate) => candidate.key === key);
    setSaving(key);
    void api<SettingItem>(`/api/v1/settings/${key}`, {
      method: 'PATCH',
      body: JSON.stringify({
        value,
        ...(item === undefined ? {} : { expectedVersion: item.version }),
      }),
    })
      .then((saved) => {
        setData((current) =>
          current === null
            ? current
            : {
                ...current,
                items:
                  item === undefined
                    ? [...current.items, saved]
                    : current.items.map((candidate) =>
                        candidate.key === key ? saved : candidate,
                      ),
              },
        );
        setSaving('');
      })
      .catch(() => setSaving('保存失败'));
  };
  const setting = (key: string): SettingItem | undefined =>
    data?.items.find((item) => item.key === key);
  const quality = setting('quality_thresholds')?.value as
    | {
        minSourceCoverage?: number;
        minPrimarySources?: number;
        minDirectionScore?: number;
        maxRisk?: number;
        minSourceTotalScore?: number;
      }
    | undefined;
  const budget = setting('search_budget')?.value as
    { maxQueries?: number; maxResultsPerQuery?: number; maxFetches?: number } | undefined;
  const aliases = setting('model_aliases')?.value;
  return (
    <>
      <div className="content">
        <PageHeading
          title="系统设置"
          description="管理非敏感运行参数、平台策略引用和连接健康状态。"
        />
        <div className="settings-grid">
          <section className="card">
            <div className="card-heading">
              <h2>非敏感配置</h2>
              <span>密钥只显示状态</span>
            </div>
            <div className="card-body">
              {data ? (
                <>
                  <div className="setting-row">
                    <span className="setting-key">模型别名</span>
                    <span className="setting-value">{JSON.stringify(aliases ?? {})}</span>
                    <span className="small muted">只读引用</span>
                  </div>
                  <div className="setting-editor">
                    <label htmlFor="setting-max-queries">搜索查询上限</label>
                    <input
                      id="setting-max-queries"
                      type="number"
                      min="1"
                      max="50"
                      value={maxQueries}
                      onChange={(event) => setMaxQueries(Number(event.target.value))}
                    />
                    <button
                      className="button compact"
                      onClick={() =>
                        updateSetting('search_budget', {
                          maxQueries,
                          maxResultsPerQuery: budget?.maxResultsPerQuery ?? 10,
                          maxFetches: budget?.maxFetches ?? 20,
                        })
                      }
                    >
                      {saving === 'search_budget' ? '保存中' : '保存'}
                    </button>
                  </div>
                  <div className="setting-editor">
                    <label htmlFor="setting-direction-score">自动选向最低分</label>
                    <input
                      id="setting-direction-score"
                      type="number"
                      min="0"
                      max="100"
                      value={minDirectionScore}
                      onChange={(event) =>
                        setMinDirectionScore(Number(event.target.value))
                      }
                    />
                    <button
                      className="button compact"
                      onClick={() =>
                        updateSetting('quality_thresholds', {
                          minSourceCoverage: quality?.minSourceCoverage ?? 0.9,
                          minPrimarySources: quality?.minPrimarySources ?? 1,
                          minDirectionScore,
                          maxRisk: quality?.maxRisk ?? 0.3,
                          minSourceTotalScore: quality?.minSourceTotalScore ?? 40,
                        })
                      }
                    >
                      {saving === 'quality_thresholds' ? '保存中' : '保存'}
                    </button>
                  </div>
                  <div className="setting-row">
                    <span className="setting-key">强制人工批准</span>
                    <span className="status success">已启用且不可关闭</span>
                    <span className="small muted">安全门禁</span>
                  </div>
                  <div className="setting-row">
                    <span className="setting-key">内容中心</span>
                    <span className="small muted">
                      令牌由服务端环境变量提供，以下参数保存后立即生效
                    </span>
                  </div>
                  <div className="setting-editor">
                    <label htmlFor="content-path">MinIO 上传路径</label>
                    <input
                      id="content-path"
                      value={contentCenter.path}
                      onChange={(event) =>
                        setContentCenter({ ...contentCenter, path: event.target.value })
                      }
                    />
                  </div>
                  <div className="setting-editor">
                    <label htmlFor="content-max-mb">图片大小上限（MiB）</label>
                    <input
                      id="content-max-mb"
                      type="number"
                      min="1"
                      max="100"
                      value={contentCenter.maxUploadBytes / (1024 * 1024)}
                      onChange={(event) =>
                        setContentCenter({
                          ...contentCenter,
                          maxUploadBytes: Number(event.target.value) * 1024 * 1024,
                        })
                      }
                    />
                  </div>
                  <div className="setting-editor">
                    <label htmlFor="content-download-expiry">下载链接有效期（秒）</label>
                    <input
                      id="content-download-expiry"
                      type="number"
                      min="60"
                      max="3600"
                      value={contentCenter.downloadExpiresIn}
                      onChange={(event) =>
                        setContentCenter({
                          ...contentCenter,
                          downloadExpiresIn: Number(event.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="setting-editor">
                    <label htmlFor="content-cdn-expiry">
                      预览链接有效期（秒，0 为永久）
                    </label>
                    <input
                      id="content-cdn-expiry"
                      type="number"
                      min="0"
                      max="3600"
                      value={contentCenter.cdnExpiresIn}
                      onChange={(event) =>
                        setContentCenter({
                          ...contentCenter,
                          cdnExpiresIn: Number(event.target.value),
                        })
                      }
                    />
                    <button
                      className="button compact"
                      disabled={saving === 'content_center'}
                      onClick={() => updateSetting('content_center', contentCenter)}
                    >
                      {saving === 'content_center' ? '保存中' : '保存内容中心设置'}
                    </button>
                  </div>
                  <div className="setting-row">
                    <span className="setting-key">xiaohongshu policy</span>
                    <span className="setting-value">{data.policy.version}</span>
                    <span className="status success">生效</span>
                  </div>
                </>
              ) : (
                <div className="empty">设置服务暂不可用</div>
              )}
            </div>
          </section>
          <section className="card">
            <div className="card-heading">
              <h2>连接状态</h2>
              <span>服务端检查</span>
            </div>
            <div className="card-body">
              {Object.entries(
                data?.connections ?? {
                  database: 'unknown',
                  redis: 'unknown',
                  publisher: 'unknown',
                },
              ).map(([key, value]) => (
                <div className="connection" key={key}>
                  <span>{key}</span>
                  <span>{value}</span>
                </div>
              ))}
              {Object.entries(data?.secrets ?? {}).map(([key, value]) => (
                <div className="connection" key={key}>
                  <span>{key}</span>
                  <span>{value}</span>
                </div>
              ))}
              <div className="alert" style={{ marginTop: 16 }}>
                <Icon name="info" />
                <span>
                  调度器使用受保护的 POST /api/v1/runs 接口与
                  Idempotency-Key，不在管理台保存调度密钥。
                </span>
              </div>
              <pre className="code-block">{`curl -X POST "$API_BASE/api/v1/runs" \\\n  -H "Authorization: Bearer $SCHEDULER_TOKEN" \\\n  -H "Idempotency-Key: daily-2026-09-23"`}</pre>
            </div>
          </section>
        </div>
        <div className="settings-grid account-settings">
          <section className="card">
            <div className="card-heading">
              <h2>我的账号</h2>
              <span>{user.role === 'SUPER_ADMIN' ? '超级管理员' : '管理员'}</span>
            </div>
            <div className="card-body">
              <div className="setting-row">
                <span className="setting-key">用户名</span>
                <strong>{user.username}</strong>
                <span className="status neutral">{user.role}</span>
              </div>
              <div className="setting-editor password-editor">
                <label htmlFor="current-admin-password">当前密码</label>
                <input
                  id="current-admin-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
                <label htmlFor="new-admin-password">新密码</label>
                <input
                  id="new-admin-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={5}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                <button
                  className="button compact"
                  disabled={currentPassword === '' || newPassword.length < 5}
                  onClick={changeOwnPassword}
                >
                  修改我的密码
                </button>
              </div>
            </div>
          </section>
          {user.role === 'SUPER_ADMIN' ? (
            <section className="card">
              <div className="card-heading">
                <h2>管理员管理</h2>
                <span>仅 SUPER_ADMIN 可操作</span>
              </div>
              <div className="card-body">
                <div className="setting-editor admin-create-editor">
                  <label htmlFor="new-admin-username">新管理员用户名</label>
                  <input
                    id="new-admin-username"
                    value={newAdminUsername}
                    onChange={(event) => setNewAdminUsername(event.target.value)}
                  />
                  <label htmlFor="new-admin-initial-password">初始密码</label>
                  <input
                    id="new-admin-initial-password"
                    type="password"
                    minLength={5}
                    autoComplete="new-password"
                    value={newAdminPassword}
                    onChange={(event) => setNewAdminPassword(event.target.value)}
                  />
                  <button
                    className="button compact"
                    disabled={
                      newAdminUsername.trim().length < 3 || newAdminPassword.length < 5
                    }
                    onClick={createAdmin}
                  >
                    <Icon name="plus" />
                    创建 ADMIN
                  </button>
                </div>
                <div className="admin-list">
                  {admins.map((admin) => (
                    <div className="admin-row" key={admin.id}>
                      <div>
                        <strong>{admin.username}</strong>
                        <span>{admin.role}</span>
                      </div>
                      {admin.role === 'ADMIN' ? (
                        <button
                          className="button compact"
                          onClick={() => setResetTarget(admin)}
                        >
                          重置密码
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}
        </div>
        {accountMessage ? <div className="account-message">{accountMessage}</div> : null}
      </div>
      {resetTarget ? (
        <Modal
          title={`重置 ${resetTarget.username} 的密码`}
          onClose={() => setResetTarget(null)}
          footer={
            <>
              <button className="button" onClick={() => setResetTarget(null)}>
                取消
              </button>
              <button
                className="button primary"
                disabled={resetMode === 'specified' && resetPassword.length < 5}
                onClick={resetAdminPassword}
              >
                确认重置
              </button>
            </>
          }
        >
          <div className="form-grid">
            <label className="radio-row">
              <input
                type="radio"
                checked={resetMode === 'random'}
                onChange={() => setResetMode('random')}
              />
              随机生成密码并仅展示一次
            </label>
            <label className="radio-row">
              <input
                type="radio"
                checked={resetMode === 'specified'}
                onChange={() => setResetMode('specified')}
              />
              指定新密码
            </label>
            {resetMode === 'specified' ? (
              <div className="form-field full">
                <label htmlFor="specified-reset-password">新密码</label>
                <input
                  id="specified-reset-password"
                  type="password"
                  minLength={5}
                  autoComplete="new-password"
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                />
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function AdminLoginPage({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    void api<{ user: AdminUser }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
      .then((value) => onLogin(value.user))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '登录失败'),
      )
      .finally(() => setSubmitting(false));
  };
  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark">
            <Icon name="grid" />
          </span>
          <div>
            <h1>内容工作台</h1>
            <p>使用管理员账号登录</p>
          </div>
        </div>
        <div className="form-field full">
          <label htmlFor="admin-username">用户名</label>
          <input
            id="admin-username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoFocus
          />
        </div>
        <div className="form-field full">
          <label htmlFor="admin-password">密码</label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? <div className="form-error">{error}</div> : null}
        <button
          className="button primary login-submit"
          type="submit"
          disabled={submitting || username.trim() === '' || password === ''}
        >
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}

function XhsLoginModal({
  value,
  loading,
  error,
  onReload,
  onComplete,
  onClose,
}: {
  value?: LoginQrcode;
  loading: boolean;
  error: string;
  onReload: () => void;
  onComplete: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState('等待扫码');
  const [loggedInUser, setLoggedInUser] = useState('');
  useEffect(() => {
    if (value === undefined || error !== '') return;
    let active = true;
    let timer: number | undefined;
    const check = async () => {
      try {
        const result = await api<{ loggedIn: boolean; username?: string }>(
          '/api/v1/xiaohongshu/session/check',
          { method: 'POST', body: '{}' },
        );
        if (!active) return;
        if (result.loggedIn) {
          setLoggedInUser(result.username ?? '小红书账号');
          setStatus('登录成功');
          onComplete();
          active = false;
        } else {
          setStatus('等待扫码');
        }
      } catch (reason) {
        if (active) setStatus(reason instanceof Error ? reason.message : '状态检查失败');
      } finally {
        if (active) timer = window.setTimeout(() => void check(), 3_000);
      }
    };
    void check();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [error, onComplete, value]);
  return (
    <Modal
      title="登录小红书账号"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>
            关闭
          </button>
          {!loading && loggedInUser === '' ? (
            <button className="button primary" onClick={onReload}>
              <Icon name="retry" />
              刷新二维码
            </button>
          ) : null}
        </>
      }
    >
      <div className="xhs-login-body">
        {loading ? <div className="empty">正在获取登录二维码…</div> : null}
        {error ? (
          <div className="alert danger">
            <Icon name="warning" />
            <span>{error}</span>
          </div>
        ) : null}
        {!loading && value?.qrCodeDataUrl && loggedInUser === '' ? (
          <>
            <img
              className="xhs-qrcode"
              src={value.qrCodeDataUrl}
              alt="小红书登录二维码"
            />
            <strong>请使用小红书 App 扫码登录</strong>
            <span className="muted small">
              二维码约 4 分钟后失效，请在手机端完成确认。
            </span>
          </>
        ) : null}
        {!loading && (value?.alreadyLoggedIn || loggedInUser !== '') ? (
          <div className="login-success">
            <Icon name="check" />
            <strong>{loggedInUser ? `${loggedInUser} 登录成功` : '当前已经登录'}</strong>
          </div>
        ) : null}
        {!loading && !error ? <span className="status neutral">{status}</span> : null}
      </div>
    </Modal>
  );
}

export default function ConsoleApp() {
  const [location, setLocation] = useState(viewFromLocation);
  const [theme, setTheme] = useTheme();
  const [currentUser, setCurrentUser] = useState<AdminUser | null>();
  const [overview, setOverview] = useState<ApiState>();
  const [showCreate, setShowCreate] = useState(false);
  const [showXhsLogin, setShowXhsLogin] = useState(false);
  const [loginQrcode, setLoginQrcode] = useState<LoginQrcode>();
  const [loginQrcodeLoading, setLoginQrcodeLoading] = useState(false);
  const [loginQrcodeError, setLoginQrcodeError] = useState('');
  useEffect(() => {
    const onPop = () => setLocation(viewFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    void api<{ user: AdminUser }>('/api/v1/auth/me')
      .then((value) => setCurrentUser(value.user))
      .catch(() => setCurrentUser(null));
  }, []);
  const loadOverview = useCallback(() => {
    void api<ApiState>('/api/v1/overview')
      .then(setOverview)
      .catch((reason: unknown) => {
        setOverview(undefined);
        if (reason instanceof ApiError && reason.status === 401) setCurrentUser(null);
      });
  }, []);
  useEffect(() => {
    if (currentUser && location.view === 'overview') loadOverview();
  }, [currentUser, location.view, loadOverview]);
  const loadLoginQrcode = useCallback(() => {
    setLoginQrcodeLoading(true);
    setLoginQrcodeError('');
    setLoginQrcode(undefined);
    void api<LoginQrcode>('/api/v1/xiaohongshu/session/login-qrcode', {
      method: 'POST',
      body: '{}',
    })
      .then(setLoginQrcode)
      .catch((reason: unknown) =>
        setLoginQrcodeError(reason instanceof Error ? reason.message : '二维码获取失败'),
      )
      .finally(() => setLoginQrcodeLoading(false));
  }, []);
  const openXhsLogin = useCallback(() => {
    setShowXhsLogin(true);
    loadLoginQrcode();
  }, [loadLoginQrcode]);
  const completeXhsLogin = useCallback(() => loadOverview(), [loadOverview]);
  const logout = useCallback(() => {
    void api('/api/v1/auth/logout', { method: 'POST', body: '{}' }).finally(() => {
      setCurrentUser(null);
      setOverview(undefined);
    });
  }, []);
  const create = (input: {
    topic: string;
    directionMode: string;
    publishMode: string;
    accountId: string;
  }) => {
    void api('/api/v1/runs', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ ...input, platform: 'xiaohongshu' }),
    })
      .then(() => {
        setShowCreate(false);
        navigate('workflows');
      })
      .catch(() => undefined);
  };
  if (currentUser === undefined) {
    return <div className="app-loading">正在加载管理后台…</div>;
  }
  if (currentUser === null) {
    return <AdminLoginPage onLogin={setCurrentUser} />;
  }
  let content: React.ReactNode;
  if (location.id !== undefined && location.view === 'workflows')
    content = (
      <WorkflowDetailView id={location.id} onBack={() => navigate('workflows')} />
    );
  else if (location.id !== undefined && location.view === 'drafts')
    content = <DraftEditorView id={location.id} onBack={() => navigate('drafts')} />;
  else if (location.view === 'overview')
    content = (
      <OverviewView data={overview} onRefresh={loadOverview} onLogin={openXhsLogin} />
    );
  else if (location.view === 'workflows')
    content = <WorkflowsView onOpen={(id) => navigate(`workflow/${id}`)} />;
  else if (location.view === 'drafts')
    content = <DraftsView onOpen={(id) => navigate(`draft/${id}`)} />;
  else if (location.view === 'research') content = <ResearchView />;
  else if (location.view === 'publishes') content = <PublishesView />;
  else content = <SettingsView user={currentUser} />;
  return (
    <>
      <Shell
        active={location.view}
        mode={theme}
        onTheme={setTheme}
        onCreate={() => setShowCreate(true)}
        user={currentUser}
        onLogout={logout}
      >
        {content}
      </Shell>
      {showCreate ? (
        <CreateRunModal onClose={() => setShowCreate(false)} onCreate={create} />
      ) : null}
      {showXhsLogin ? (
        <XhsLoginModal
          value={loginQrcode}
          loading={loginQrcodeLoading}
          error={loginQrcodeError}
          onReload={loadLoginQrcode}
          onComplete={completeXhsLogin}
          onClose={() => setShowXhsLogin(false)}
        />
      ) : null}
    </>
  );
}

function CreateRunModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    topic: string;
    directionMode: string;
    publishMode: string;
    accountId: string;
  }) => void;
}) {
  const [topic, setTopic] = useState('');
  const [directionMode, setDirectionMode] = useState('manual');
  const [publishMode, setPublishMode] = useState('review');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<Array<{ id: string; alias: string }>>([]);
  useEffect(() => {
    void api<{ items: Array<{ id: string; alias: string }> }>(
      '/api/v1/xiaohongshu/accounts',
    )
      .then((value) => {
        setAccounts(value.items);
        setAccountId(value.items[0]?.id ?? '');
      })
      .catch(() => undefined);
  }, []);
  return (
    <Modal
      title="新建小红书工作流"
      onClose={onClose}
      footer={
        <>
          <button className="button" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={topic.trim() === '' || accountId === ''}
            onClick={() => onCreate({ topic, directionMode, publishMode, accountId })}
          >
            <Icon name="play" />
            创建并开始
          </button>
        </>
      }
    >
      <div className="alert">
        <Icon name="info" />
        <span>
          首期仅支持小红书；发布模式即使选择自动，也会受服务端强制人工批准策略保护。
        </span>
      </div>
      <div className="form-grid" style={{ marginTop: 16 }}>
        <div className="form-field full">
          <label htmlFor="run-topic">内容主题</label>
          <input
            id="run-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：PostgreSQL 17 升级注意事项"
          />
        </div>
        <div className="form-field">
          <label htmlFor="run-direction">方向选择</label>
          <select
            id="run-direction"
            value={directionMode}
            onChange={(event) => setDirectionMode(event.target.value)}
          >
            <option value="manual">人工选择</option>
            <option value="auto">自动选择</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="run-publish">发布模式</label>
          <select
            id="run-publish"
            value={publishMode}
            onChange={(event) => setPublishMode(event.target.value)}
          >
            <option value="review">人工审核</option>
            <option value="auto">自动发布（受安全门禁）</option>
          </select>
        </div>
        <div className="form-field full">
          <label htmlFor="run-account">小红书账号</label>
          <select
            id="run-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">请选择账号</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.alias}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
}
