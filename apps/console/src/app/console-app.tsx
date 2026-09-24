'use client';

import { Icon, type IconName } from '@tutor-flow/ui';
import {
  DEFAULT_XHS_PROMPT,
  LLM_TASKS,
  PLATFORM_OPTIONS,
  formatResearchDocumentImage,
  type Platform,
  type ContentPromptsConfig,
  type LlmModelsConfig,
  type ModelSelection,
} from '@tutor-flow/domain';
import type { DraftMedia } from '@tutor-flow/domain';
import {
  Fragment,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

import { WorkflowDetailView } from './workflow-detail.js';
import { LoadingState } from './loading-state.js';
import { formatTokenCount } from './number-format.js';
import { ToastNotice } from './toast.js';

import './styles.css';

type ViewName = 'overview' | 'workflows' | 'drafts' | 'research' | 'settings';
type ThemeMode = 'light' | 'dark' | 'system';

function contentPromptsFromSettings(
  saved?: ContentPromptsConfig,
  legacyXhsPrompt?: string,
): ContentPromptsConfig {
  return {
    platforms: PLATFORM_OPTIONS.map((option) => {
      const existing = saved?.platforms.find((item) => item.id === option.id);
      if (existing)
        return { id: option.id, name: option.name, prompts: existing.prompts };
      if (!saved && option.id === 'xiaohongshu') {
        return {
          id: option.id,
          name: option.name,
          prompts: [
            {
              id: 'xhs-default',
              name: '默认提示词',
              content: legacyXhsPrompt ?? DEFAULT_XHS_PROMPT,
              active: true,
            },
          ],
        };
      }
      return { id: option.id, name: option.name, prompts: [] };
    }),
  };
}

type ModelProviderEditor = Omit<
  LlmModelsConfig['providers'][number],
  'apiKeyEncrypted'
> & {
  apiKey: string;
  hasApiKey: boolean;
};

type LlmModelsEditor = Omit<LlmModelsConfig, 'providers'> & {
  providers: ModelProviderEditor[];
};

interface AdminUser {
  id: string;
  username: string;
  role: 'SUPER_ADMIN' | 'ADMIN';
}

interface ApiState {
  metrics?: {
    runningRuns: number;
    pendingDrafts: number;
    searchQueries: number;
    tokenUsage: number;
  };
  recentActivity?: Array<{
    id: number;
    occurredAt: string;
    action: string;
    resourceType: string;
    resourceId: string;
    payload?: unknown;
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

interface ContentCenterConfig {
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
  if (['overview', 'workflows', 'drafts', 'research', 'settings'].includes(value))
    return { view: value as ViewName };
  return { view: 'overview' };
}

function navigate(value: string): void {
  if (typeof window === 'undefined') return;
  window.history.pushState({}, '', `/?view=${encodeURIComponent(value)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers,
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

function uploadFileWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('content-type', file.type);
    request.upload.onprogress = (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
      onProgress(Math.min(100, Math.round((event.loaded / total) * 100)));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      reject(new Error(`图片上传失败（${request.status}）`));
    };
    request.onerror = () => reject(new Error('图片上传失败'));
    request.onabort = () => reject(new Error('图片上传已取消'));
    request.send(file);
  });
}

const uploadProgressPhases = {
  initializingStart: 3,
  initializingEnd: 15,
  uploadingEnd: 95,
} as const;

function ResearchImagePreview({ fileId, alt }: { fileId: number; alt: string }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void api<{ url: string }>(`/api/v1/media/${fileId}/cdn-link`)
      .then((result) => {
        if (active) setUrl(result.url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [fileId]);
  if (failed) return <span className="research-image-error">图片预览加载失败</span>;
  if (url === '') return <span className="research-image-loading">图片加载中…</span>;
  return <img className="research-document-image" src={url} alt={alt} />;
}

function researchMarkdownUrlTransform(url: string): string {
  if (/^content-center:\/\/file\/\d+$/.test(url)) return url;
  return defaultUrlTransform(url);
}

// 高亮语言别名：让用户手写的 ```py、```js 等围栏也能命中高亮
const codeHighlightOptions = {
  aliases: {
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    'c++': 'cpp',
    golang: 'go',
    rs: 'rust',
    sh: 'bash',
    shell: 'bash',
    yml: 'yaml',
  },
};

// “代码”按钮下拉列表：显示名 + 围栏语言标识（均在高亮默认语言集内）
const CODE_LANGUAGES: Array<[label: string, id: string]> = [
  ['C', 'c'],
  ['C++', 'cpp'],
  ['Java', 'java'],
  ['Python', 'python'],
  ['JavaScript', 'javascript'],
  ['TypeScript', 'typescript'],
  ['Go', 'go'],
  ['Rust', 'rust'],
  ['SQL', 'sql'],
  ['Bash', 'bash'],
  ['JSON', 'json'],
  ['YAML', 'yaml'],
  ['HTML', 'html'],
  ['CSS', 'css'],
];

function ResearchMarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      urlTransform={researchMarkdownUrlTransform}
      rehypePlugins={[[rehypeHighlight, codeHighlightOptions]]}
      components={{
        pre({ children }) {
          // 围栏代码块外层包一层容器，右上角展示语言标签（如 java）
          const codeElement = children as ReactElement<{ className?: string }>;
          const match = /language-(\S+)/.exec(codeElement?.props?.className ?? '');
          return (
            <div className="research-code-block">
              {match ? (
                <span className="research-code-block-lang">{match[1]}</span>
              ) : null}
              <pre>{children}</pre>
            </div>
          );
        },
        img({ src, alt }) {
          const match = /^content-center:\/\/file\/(\d+)$/.exec(
            typeof src === 'string' ? src : '',
          );
          if (!match) return null;
          return (
            <ResearchImagePreview
              fileId={Number(match[1])}
              alt={typeof alt === 'string' ? alt : '图片'}
            />
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
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
      <aside className="sidebar" aria-label="应用导航">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="grid" />
          </span>
          <span>
            内容工作台<span className="brand-subtitle">研究 · 创作 · 审核</span>
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
        <div className="sidebar-footer">tutor-flow powered by kk</div>
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
            <button
              className="button primary topbar-create"
              onClick={onCreate}
              aria-label="新建任务"
            >
              <Icon name="plus" />
              <span>新建任务</span>
            </button>
          </div>
        </header>
        <div className="main-content-scroll">{children}</div>
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

function activityLabel(action: string, payload: unknown): string {
  const data =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  const step =
    typeof data['stepType'] === 'string'
      ? ((
          {
            QUERY_PLANNING: '检索规划',
            SEARCH: '检索资料',
            FETCH_SOURCES: '抓取来源',
            DEDUPE_SOURCES: '资料去重',
            SCORE_SOURCES: '来源评分',
            EXTRACT_CLAIMS: '提取事实',
            GENERATE_DIRECTIONS: '生成方向',
            SELECT_DIRECTION: '选择方向',
            GENERATE_CANONICAL: '生成规范稿',
            ADAPT_XIAOHONGSHU: '生成小红书内容',
            MODERATE_CONTENT: '内容校验',
            CREATE_DRAFT: '创建草稿',
          } as Record<string, string>
        )[data['stepType']] ?? data['stepType'])
      : '任务';
  if (action === 'run.created')
    return data['triggerType'] === 'scheduler' ? '定时任务启动' : '任务已启动';
  if (action === 'step.completed') return `${step}已完成`;
  if (action === 'step.failed') return `${step}失败`;
  if (action === 'run.status_changed')
    return data['to'] === 'NEEDS_REVIEW' ? '内容已生成，等待审核' : `${step}进行中`;
  return (
    (
      {
        'run.direction_selected': '已选择内容方向',
        'draft.approved': '草稿审核通过',
        'run.cancelled': '任务已取消',
        'run.waiting_direction': '等待选择方向',
        'run.retry_scheduled': '步骤将重试',
        'run.succeeded': '任务完成',
      } as Record<string, string>
    )[action] ?? action
  );
}

function OverviewView({
  data,
  loading,
  error,
  onRefresh,
}: {
  data?: ApiState;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const metrics = data?.metrics ?? {
    runningRuns: 0,
    pendingDrafts: 0,
    searchQueries: 0,
    tokenUsage: 0,
  };
  const cards = [
    ['执行中任务', metrics.runningRuns, '服务端实时统计'],
    ['待审核草稿', metrics.pendingDrafts, '需要运营处理'],
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
      {loading ? <LoadingState label="正在加载概览数据…" /> : null}
      {!loading && error ? <div className="card empty">{error}</div> : null}
      {!loading && !error ? (
        <>
          <div className="metrics">
            {cards.map(([label, value, note]) => (
              <div className="metric" key={String(label)}>
                <div className="metric-label">{label}</div>
                <div className="metric-value">
                  {label === '模型 Token'
                    ? formatTokenCount(Number(value))
                    : Number(value).toLocaleString('zh-CN')}
                </div>
                <div className="metric-note">{note}</div>
              </div>
            ))}
          </div>
          <div className="grid-two">
            <section className="card">
              <div className="card-heading">
                <h2>最近活动</h2>
                <span>任务执行进展</span>
              </div>
              <div className="card-body">
                {data?.recentActivity?.length ? (
                  <div className="timeline">
                    {data.recentActivity.slice(0, 5).map((item) => (
                      <div className="timeline-item" key={item.id}>
                        <strong>{activityLabel(item.action, item.payload)}</strong>
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
                    生成小红书风格标题、正文和标签，在草稿箱打磨审核后复制使用。
                  </span>
                </div>
                <p className="muted small">
                  研究正文只在研究步骤内即时使用，数据库保留来源元数据、事实关系和审计链。
                </p>
              </div>
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}

function WorkflowsView({
  onOpen,
  refreshKey,
}: {
  onOpen: (id: string) => void;
  refreshKey: number;
}) {
  const [items, setItems] = useState<RunItem[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    void api<{ items: RunItem[] }>('/api/v1/runs')
      .then((value) => {
        setItems(value.items);
        setError('');
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '运行任务加载失败'),
      )
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (status === '' || item.status === status) &&
          item.topic.toLowerCase().includes(query.toLowerCase()),
      ),
    [items, query, status],
  );
  const remove = async (item: RunItem) => {
    if (
      !window.confirm(
        '确定删除这个工作流？它会从列表中移除，历史数据会保留。正在执行或发布中的工作流不能删除。',
      )
    ) {
      return;
    }
    setRemoving(item.runId);
    try {
      await api(`/api/v1/runs/${item.runId}`, { method: 'DELETE' });
      setItems((current) =>
        current.filter((candidate) => candidate.runId !== item.runId),
      );
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '工作流删除失败');
    } finally {
      setRemoving(null);
    }
  };
  const deletableStatuses = [
    'WAITING_DIRECTION',
    'NEEDS_REVIEW',
    'NEEDS_HUMAN',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
  ];
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
      <ToastNotice message={error} />
      <div className="run-list">
        {loading ? <LoadingState label="正在加载工作流…" /> : null}
        {!loading
          ? filtered.map((item) => (
              <div
                className="run-row run-row-clickable"
                key={item.runId}
                role="link"
                tabIndex={0}
                aria-label={`打开工作流：${item.topic}`}
                onClick={() => onOpen(item.runId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen(item.runId);
                  }
                }}
              >
                <span className="run-topic">
                  <strong title={item.topic}>{item.topic}</strong>
                  <span>
                    {item.runId} · {item.platform}
                  </span>
                </span>
                <Status value={item.status} />
                <span className="muted">
                  {item.directionMode === 'manual' ? '人工选向' : '自动选向'}
                </span>
                <span className="muted">{formatTime(item.updatedAt)}</span>
                <span className="run-actions">
                  <button
                    className="button compact danger"
                    disabled={
                      !deletableStatuses.includes(item.status) || removing === item.runId
                    }
                    title={
                      deletableStatuses.includes(item.status)
                        ? '删除工作流'
                        : '运行中的工作流不能删除'
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(item);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {removing === item.runId ? '删除中…' : '删除'}
                  </button>
                </span>
              </div>
            ))
          : null}
        {!loading && !error && filtered.length === 0 ? (
          <div className="card empty">
            <Icon name="workflow" />
            暂无符合条件的工作流
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DraftsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<DraftItem[]>([]);
  const [status, setStatus] = useState('PENDING_REVIEW');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    void api<{ items: DraftItem[] }>(`/api/v1/drafts?status=${status}`)
      .then((value) => {
        setItems(value.items);
        setError('');
      })
      .catch((reason: unknown) => {
        setItems([]);
        setError(reason instanceof Error ? reason.message : '草稿列表加载失败');
      })
      .finally(() => setLoading(false));
  }, [status]);
  useEffect(() => {
    load();
  }, [load]);
  const remove = async (item: DraftItem) => {
    if (!window.confirm('确定删除这份草稿？待审核的关联工作流会取消，历史数据会保留。')) {
      return;
    }
    setRemoving(item.runId);
    try {
      await api(`/api/v1/drafts/${item.runId}`, { method: 'DELETE' });
      setItems((current) =>
        current.filter((candidate) => candidate.runId !== item.runId),
      );
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '草稿删除失败');
    } finally {
      setRemoving(null);
    }
  };
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
      <ToastNotice message={error} />
      <div className="card">
        <div className="table-wrap draft-table-wrap">
          {loading ? <LoadingState label="正在加载草稿…" /> : null}
          {!loading ? (
            <table className="draft-table">
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
                    <td data-label="标题">
                      <strong className="truncate-text" title={item.title}>
                        {item.title}
                      </strong>
                    </td>
                    <td data-label="主题">
                      <span className="truncate-text" title={item.topic}>
                        {item.topic}
                      </span>
                    </td>
                    <td data-label="修订">v{item.revision}</td>
                    <td data-label="状态">
                      <Status value={item.status} />
                    </td>
                    <td data-label="更新时间">{formatTime(item.updatedAt)}</td>
                    <td data-label="操作">
                      <span className="run-actions">
                        <button
                          className="button compact"
                          onClick={() => onOpen(item.runId)}
                        >
                          <Icon name="eye" />
                          打开
                        </button>
                        <button
                          className="button compact danger"
                          disabled={removing === item.runId}
                          onClick={() => void remove(item)}
                        >
                          {removing === item.runId ? '删除中…' : '删除'}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!loading && !error && items.length === 0 ? (
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
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    void api<DraftDetails>(`/api/v1/drafts/${id}`)
      .then((value) => {
        setDraft(value);
        setDirty(false);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '草稿加载失败'),
      )
      .finally(() => setLoading(false));
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
        setState('审核通过，内容任务已完成');
        load();
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '批准失败'),
      );
  };
  if (draft === null)
    return (
      <div className="content">
        <button className="button" onClick={onBack}>
          <Icon name="back" />
          返回草稿箱
        </button>
        {loading ? (
          <LoadingState label="正在加载草稿…" />
        ) : (
          <div className="card empty">{error || '未找到草稿'}</div>
        )}
      </div>
    );
  return (
    <div className="content">
      <PageHeading
        title="草稿编辑"
        description={`${draft.runId} · 当前修订 v${draft.revision}`}
        action={
          <div className="actions">
            {loading ? (
              <LoadingState className="loading-state-inline" label="同步中…" />
            ) : null}
            <button className="button" onClick={onBack}>
              <Icon name="back" />
              返回
            </button>
            <button className="button" onClick={() => save()}>
              <Icon name="save" />
              保存
            </button>
            <button
              className="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    `${draft.title}\n\n${draft.body}\n\n${draft.tags.map((tag) => `#${tag}`).join(' ')}`,
                  )
                  .then(() => setState('文案已复制，可手动粘贴到小红书'))
                  .catch(() => setError('复制失败，请手动选中内容复制'));
              }}
            >
              复制小红书文案
            </button>
            <button className="button primary" onClick={approve} disabled={dirty}>
              <Icon name="check" />
              审核通过
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
          </div>
        </section>
      </div>
      <ToastNotice message={error} />
    </div>
  );
}

function ResearchView() {
  type Doc = {
    id: string;
    title: string;
    markdown: string;
    folderId: string | null;
    updatedAt?: string;
  };
  type Folder = { id: string; name: string; parentId: string | null };
  type UploadedImage = { fileId: number; name: string; contentType: string };
  type PendingImage = UploadedImage & { start: number; end: number };
  type FailedImageUpload = { file: File; start: number; end: number };
  const [library, setLibrary] = useState<{ documents: Doc[]; folders: Folder[] }>({
    documents: [],
    folders: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [folderId, setFolderId] = useState('');
  const [editorMode, setEditorMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageNotice, setImageNotice] = useState('');
  const [imageNoticeState, setImageNoticeState] = useState<
    'neutral' | 'uploading' | 'error'
  >('neutral');
  const [imageUploadProgress, setImageUploadProgress] = useState(0);
  const [failedImageUpload, setFailedImageUpload] = useState<FailedImageUpload | null>(
    null,
  );
  const [imageDragActive, setImageDragActive] = useState(false);
  const [codeMenuOpen, setCodeMenuOpen] = useState(false);
  const markdownRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const codeMenuRef = useRef<HTMLDivElement>(null);
  const refresh = () => {
    setLoading(true);
    return void api<typeof library>('/api/v1/research-library')
      .then((value) => {
        setLibrary(value);
        setLoadError('');
      })
      .catch((reason: unknown) =>
        setLoadError(reason instanceof Error ? reason.message : '研究资料加载失败'),
      )
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);
  useEffect(() => {
    if (!codeMenuOpen) return;
    // 点击下拉外部或按 Esc 时收起语言列表
    const onPointerDown = (event: PointerEvent) => {
      if (!codeMenuRef.current?.contains(event.target as Node)) setCodeMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCodeMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [codeMenuOpen]);
  const currentFolder =
    library.folders.find((folder) => folder.id === activeFolderId) ?? null;
  const childFolders = library.folders.filter(
    (folder) => folder.parentId === activeFolderId,
  );
  const visibleFolders = search.trim()
    ? library.folders.filter((folder) =>
        folder.name.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : childFolders;
  const visibleDocs = library.documents.filter((doc) => {
    const matchesFolder = search.trim() !== '' || doc.folderId === activeFolderId;
    const matchesSearch = `${doc.title}\n${doc.markdown}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
    return matchesFolder && matchesSearch;
  });
  const docsInFolder = (id: string) =>
    library.documents.filter((doc) => doc.folderId === id).length;
  const openEditor = (doc?: Doc) => {
    setEditingId(doc?.id ?? null);
    setTitle(doc?.title ?? '');
    setMarkdown(doc?.markdown ?? '');
    setFolderId(doc?.folderId ?? activeFolderId ?? '');
    setEditorMode('split');
    setPendingImage(null);
    setImageNotice('');
    setImageNoticeState('neutral');
    setImageUploadProgress(0);
    setFailedImageUpload(null);
    setCodeMenuOpen(false);
    setEditorOpen(true);
  };
  const save = () => {
    const payload = {
      title: title.trim() || '未命名资料',
      markdown,
      folderId: folderId || null,
    };
    void api<Doc>(
      editingId
        ? `/api/v1/research-library/documents/${editingId}`
        : '/api/v1/research-library/documents',
      {
        method: editingId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      },
    ).then(() => {
      setEditorOpen(false);
      refresh();
    });
  };
  const addFolder = () => {
    const name = window.prompt('文件夹名称');
    if (!name?.trim()) return;
    void api('/api/v1/research-library/folders', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim(), parentId: activeFolderId }),
    }).then(refresh);
  };
  const renameFolder = (folder: Folder) => {
    const name = window.prompt('重命名文件夹', folder.name);
    if (!name?.trim() || name.trim() === folder.name) return;
    void api(`/api/v1/research-library/folders/${folder.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim() }),
    }).then(refresh);
  };
  const removeFolder = (folder: Folder) => {
    const message = `确定删除文件夹“${folder.name}”吗？该文件夹及其子文件夹中的所有资料都会被递归删除，此操作无法撤销。`;
    if (!window.confirm(message)) return;
    const deletedFolderIds = new Set([folder.id]);
    let foundChild = true;
    while (foundChild) {
      foundChild = false;
      for (const child of library.folders) {
        if (
          child.parentId &&
          deletedFolderIds.has(child.parentId) &&
          !deletedFolderIds.has(child.id)
        ) {
          deletedFolderIds.add(child.id);
          foundChild = true;
        }
      }
    }
    void api(`/api/v1/research-library/folders/${folder.id}`, { method: 'DELETE' }).then(
      () => {
        if (activeFolderId && deletedFolderIds.has(activeFolderId))
          setActiveFolderId(folder.parentId);
        refresh();
      },
    );
  };
  const deleteDocs = (ids: string[]) => {
    if (
      !ids.length ||
      !window.confirm(`确定删除选中的 ${ids.length} 篇资料吗？此操作无法撤销。`)
    )
      return;
    void api('/api/v1/research-library/documents', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    }).then(() => {
      setSelected([]);
      setSelectionMode(false);
      refresh();
    });
  };
  const insertMarkdown = (before: string, after = '') => {
    const area = markdownRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selectedText = markdown.slice(start, end) || '文本';
    const next = `${markdown.slice(0, start)}${before}${selectedText}${after}${markdown.slice(end)}`;
    setMarkdown(next);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(
        start + before.length,
        start + before.length + selectedText.length,
      );
    });
  };
  const insertAtRange = (text: string, start: number, end: number) => {
    const prefix = start > 0 && markdown[start - 1] !== '\n' ? '\n\n' : '';
    const suffix = end < markdown.length && markdown[end] !== '\n' ? '\n\n' : '';
    const insertion = `${prefix}${text}${suffix}`;
    setMarkdown(`${markdown.slice(0, start)}${insertion}${markdown.slice(end)}`);
    requestAnimationFrame(() => {
      const position = start + insertion.length;
      markdownRef.current?.focus();
      markdownRef.current?.setSelectionRange(position, position);
    });
  };
  const insertCodeBlock = (language: string) => {
    const area = markdownRef.current;
    if (!area) return;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const selectedText = markdown.slice(start, end);
    // 代码块独占段落：紧邻文字时补一个换行
    const prefix = start > 0 && markdown[start - 1] !== '\n' ? '\n' : '';
    const suffix = end < markdown.length && markdown[end] !== '\n' ? '\n' : '';
    const insertion = `${prefix}\`\`\`${language}\n${selectedText}\n\`\`\`${suffix}`;
    setMarkdown(`${markdown.slice(0, start)}${insertion}${markdown.slice(end)}`);
    setCodeMenuOpen(false);
    requestAnimationFrame(() => {
      // 光标移动到围栏中间（选中文本时落在其末尾）
      const position = start + prefix.length + language.length + 4 + selectedText.length;
      area.focus();
      area.setSelectionRange(position, position);
    });
  };
  const uploadResearchImage = async (
    file: File,
    previousRange?: Pick<FailedImageUpload, 'start' | 'end'>,
  ) => {
    setFailedImageUpload(null);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setImageNotice('仅支持 JPEG、PNG、WebP 图片');
      setImageNoticeState('error');
      setImageUploadProgress(100);
      return;
    }
    const area = markdownRef.current;
    const start = previousRange?.start ?? area?.selectionStart ?? markdown.length;
    const end = previousRange?.end ?? area?.selectionEnd ?? start;
    setImageBusy(true);
    setImageNotice('正在上传图片…');
    setImageNoticeState('uploading');
    setImageUploadProgress(uploadProgressPhases.initializingStart);
    const initializationProgressTimer = window.setInterval(() => {
      setImageUploadProgress((current) =>
        Math.min(uploadProgressPhases.initializingEnd - 1, current + 1),
      );
    }, 350);
    try {
      let initialized: { storageKey: string; putUrl: string; source: string };
      try {
        initialized = await api('/api/v1/media/uploads/init', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            size: file.size,
            contentType: file.type,
          }),
        });
      } finally {
        window.clearInterval(initializationProgressTimer);
      }
      setImageUploadProgress(uploadProgressPhases.initializingEnd);
      await uploadFileWithProgress(initialized.putUrl, file, (uploadPercent) => {
        const uploadRange =
          uploadProgressPhases.uploadingEnd - uploadProgressPhases.initializingEnd;
        setImageUploadProgress(
          uploadProgressPhases.initializingEnd +
            Math.round((uploadPercent / 100) * uploadRange),
        );
      });
      const completed = await api<UploadedImage>('/api/v1/media/uploads/complete', {
        method: 'POST',
        body: JSON.stringify({
          storageKey: initialized.storageKey,
          source: initialized.source,
        }),
      });
      setPendingImage({ ...completed, start, end });
      setImageNotice('图片已上传，请选择处理方式');
      setImageNoticeState('neutral');
    } catch (error) {
      setImageNotice(error instanceof Error ? error.message : '图片上传失败');
      setImageNoticeState('error');
      setImageUploadProgress(100);
      setFailedImageUpload({ file, start, end });
    } finally {
      window.clearInterval(initializationProgressTimer);
      setImageBusy(false);
    }
  };
  const extractPendingImageText = async () => {
    if (pendingImage === null) return;
    setImageBusy(true);
    setImageNotice('模型正在提取图片文字…');
    try {
      const result = await api<{ text: string }>(
        '/api/v1/research-library/images/extract-text',
        {
          method: 'POST',
          body: JSON.stringify({ fileId: pendingImage.fileId }),
        },
      );
      insertAtRange(result.text, pendingImage.start, pendingImage.end);
      setPendingImage(null);
      setImageNotice('图片文字已插入');
      setImageNoticeState('neutral');
    } catch (error) {
      setImageNotice(error instanceof Error ? error.message : '图片文字提取失败');
    } finally {
      setImageBusy(false);
    }
  };
  const insertPendingImage = () => {
    if (pendingImage === null) return;
    insertAtRange(
      formatResearchDocumentImage(pendingImage.fileId, pendingImage.name),
      pendingImage.start,
      pendingImage.end,
    );
    setPendingImage(null);
    setImageNotice('图片已插入资料');
    setImageNoticeState('neutral');
  };
  if (editorOpen)
    return (
      <div className="research-editor-overlay">
        <div className="research-editor-header">
          <button className="button" onClick={() => setEditorOpen(false)}>
            ← 返回资料库
          </button>
          <input
            className="research-title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="资料标题"
          />
          <select
            className="field"
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">未分类</option>
            {library.folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
          <div className="research-mode-switch">
            {(['edit', 'split', 'preview'] as const).map((mode) => (
              <button
                key={mode}
                className={editorMode === mode ? 'active' : ''}
                onClick={() => setEditorMode(mode)}
              >
                {mode === 'edit' ? '编辑' : mode === 'split' ? '分栏' : '预览'}
              </button>
            ))}
          </div>
          <button
            className="button primary"
            disabled={imageBusy || pendingImage !== null}
            onClick={save}
          >
            保存资料
          </button>
        </div>
        <div className="research-editor-toolbar">
          <button onClick={() => insertMarkdown('# ')}>H</button>
          <button onClick={() => insertMarkdown('**', '**')}>
            <b>B</b>
          </button>
          <button onClick={() => insertMarkdown('*', '*')}>
            <i>I</i>
          </button>
          <button onClick={() => insertMarkdown('> ')}>引用</button>
          <div className="research-code-menu" ref={codeMenuRef}>
            <button
              aria-expanded={codeMenuOpen}
              aria-haspopup="menu"
              aria-label="插入代码块"
              onClick={() => setCodeMenuOpen((open) => !open)}
            >
              代码
            </button>
            {codeMenuOpen ? (
              <div className="research-code-menu-list" role="menu">
                {CODE_LANGUAGES.map(([label, id]) => (
                  <button key={id} role="menuitem" onClick={() => insertCodeBlock(id)}>
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button
            disabled={imageBusy || pendingImage !== null}
            onClick={() => imageInputRef.current?.click()}
          >
            插入图片
          </button>
          <input
            ref={imageInputRef}
            className="research-image-input"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void uploadResearchImage(file);
            }}
          />
          <span className="research-image-hint">也可以把图片拖进编辑区</span>
        </div>
        {pendingImage ? (
          <div className="research-image-choice">
            <ResearchImagePreview fileId={pendingImage.fileId} alt={pendingImage.name} />
            <div>
              <strong>{pendingImage.name}</strong>
              <p>{imageBusy ? imageNotice : '选择这张图片在资料中的处理方式。'}</p>
            </div>
            <button
              className="button"
              disabled={imageBusy}
              onClick={() => void extractPendingImageText()}
            >
              请求模型提取文字
            </button>
            <button
              className="button primary"
              disabled={imageBusy}
              onClick={insertPendingImage}
            >
              插入图片到文章
            </button>
          </div>
        ) : imageNotice ? (
          <div
            className={`research-image-notice is-${imageNoticeState}`}
            role={imageNoticeState === 'error' ? 'alert' : undefined}
            aria-live="polite"
          >
            {imageNoticeState !== 'neutral' ? (
              <span
                className="research-image-notice-fill"
                style={{ width: `${imageUploadProgress}%` }}
              />
            ) : null}
            <span className="research-image-notice-text">{imageNotice}</span>
            {imageNoticeState === 'error' && failedImageUpload ? (
              <button
                className="research-image-retry"
                type="button"
                onClick={() =>
                  void uploadResearchImage(failedImageUpload.file, failedImageUpload)
                }
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={`research-editor-panes mode-${editorMode}`}>
          {editorMode !== 'preview' ? (
            <textarea
              ref={markdownRef}
              className={imageDragActive ? 'image-drag-active' : ''}
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              onDragEnter={(event) => {
                if (event.dataTransfer.types.includes('Files')) {
                  event.preventDefault();
                  setImageDragActive(true);
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }
              }}
              onDragLeave={() => setImageDragActive(false)}
              onDrop={(event) => {
                event.preventDefault();
                setImageDragActive(false);
                if (imageBusy || pendingImage !== null) return;
                const file = [...event.dataTransfer.files].find((item) =>
                  item.type.startsWith('image/'),
                );
                if (file) void uploadResearchImage(file);
              }}
              onPaste={(event) => {
                if (imageBusy || pendingImage !== null) return;
                const file = [...event.clipboardData.files].find((item) =>
                  item.type.startsWith('image/'),
                );
                if (file) {
                  event.preventDefault();
                  void uploadResearchImage(file);
                }
              }}
              placeholder="# 研究主题\n\n在此输入或粘贴 Markdown 资料"
            />
          ) : null}
          {editorMode !== 'edit' ? (
            <div className="research-markdown-preview">
              <ResearchMarkdownPreview markdown={markdown} />
            </div>
          ) : null}
        </div>
      </div>
    );
  return (
    <div className="content">
      <PageHeading
        title="研究资料"
        description="保存 Markdown 研究资料，创建任务时可选择资料并直接生成。"
      />
      <section className="card research-library">
        <div className="card-heading">
          <h2>资料库</h2>
          <span>{library.documents.length} 篇</span>
        </div>
        <div className="card-body">
          <div className="toolbar research-library-toolbar">
            <input
              className="field"
              type="search"
              aria-label="搜索资料"
              placeholder="搜索资料标题或内容"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button className="button" onClick={addFolder}>
              创建文件夹
            </button>
            <button className="button primary" onClick={() => openEditor()}>
              ＋ 新建资料
            </button>
            <span className="research-toolbar-spacer" />
            {selectionMode ? (
              <button
                className="button"
                onClick={() => {
                  setSelectionMode(false);
                  setSelected([]);
                }}
              >
                取消选择
              </button>
            ) : null}
            <button
              className="button danger"
              disabled={selectionMode && selected.length === 0}
              onClick={() =>
                selectionMode ? deleteDocs(selected) : setSelectionMode(true)
              }
            >
              批量删除（{selected.length}）
            </button>
          </div>
          <div className="research-breadcrumb">
            {search.trim() ? (
              <strong>搜索“{search.trim()}”</strong>
            ) : (
              <>
                <button onClick={() => setActiveFolderId(null)}>资料库</button>
                {currentFolder ? (
                  <>
                    {' '}
                    / <strong>{currentFolder.name}</strong>
                  </>
                ) : (
                  <strong>全部资料</strong>
                )}
              </>
            )}
          </div>
          <div className="research-grid">
            {loading ? <LoadingState label="正在加载研究资料…" /> : null}
            {!loading && loadError ? (
              <div className="empty research-empty">{loadError}</div>
            ) : null}
            {!loading && !loadError ? (
              <>
                {(!activeFolderId || search.trim()) &&
                  visibleFolders.map((folder) => (
                    <article
                      className="research-card research-folder-card"
                      key={folder.id}
                      onClick={() => {
                        setActiveFolderId(folder.id);
                        setSelected([]);
                      }}
                    >
                      <div className="research-folder-actions">
                        <button
                          aria-label="重命名文件夹"
                          onClick={(event) => {
                            event.stopPropagation();
                            renameFolder(folder);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          aria-label="删除文件夹"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeFolder(folder);
                          }}
                        >
                          ×
                        </button>
                      </div>
                      <Icon name="folder" className="research-folder-icon" />
                      <h3>{folder.name}</h3>
                      <p>{docsInFolder(folder.id)} 篇资料</p>
                    </article>
                  ))}
                {visibleDocs.map((doc) => (
                  <article
                    className={`research-card ${selected.includes(doc.id) ? 'selected' : ''}`}
                    key={doc.id}
                    onClick={() =>
                      selectionMode
                        ? setSelected((ids) =>
                            ids.includes(doc.id)
                              ? ids.filter((id) => id !== doc.id)
                              : [...ids, doc.id],
                          )
                        : openEditor(doc)
                    }
                  >
                    {selectionMode ? (
                      <input
                        className="research-checkbox"
                        aria-label={`选择${doc.title}`}
                        type="checkbox"
                        checked={selected.includes(doc.id)}
                        onChange={() => undefined}
                      />
                    ) : null}
                    <h3>{doc.title}</h3>
                    <p>
                      {doc.markdown
                        .replace(/[#>*`|\-\[\]]/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim() || '（空白）'}
                    </p>
                    <div className="research-card-meta">
                      <span>
                        {library.folders.find((folder) => folder.id === doc.folderId)
                          ?.name ?? '未分类'}
                      </span>
                      <span>{doc.updatedAt ? formatTime(doc.updatedAt) : ''}</span>
                    </div>
                  </article>
                ))}
                {search.trim() &&
                visibleFolders.length === 0 &&
                visibleDocs.length === 0 ? (
                  <div className="empty research-empty">没有找到匹配的文件夹或资料。</div>
                ) : null}
                {!search.trim() &&
                childFolders.length === 0 &&
                visibleDocs.length === 0 ? (
                  <div className="empty research-empty">
                    这里还没有资料，点击“新建资料”开始写作。
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function ModelSettingsSection({
  value,
  saving,
  message,
  tone,
  onChange,
  onSave,
}: {
  value: LlmModelsEditor;
  saving: boolean;
  message?: string;
  tone?: 'danger' | 'info' | 'success';
  onChange: (value: LlmModelsEditor) => void;
  onSave: () => void;
}) {
  const selections: ModelSelection[] = value.providers.flatMap((provider) =>
    provider.models
      .filter((modelId) => modelId.trim() !== '')
      .map((modelId) => ({ providerId: provider.id, modelId })),
  );
  const selectionValue = (selection: ModelSelection | null | undefined) =>
    selection ? JSON.stringify(selection) : '';
  const parseSelection = (serialized: string): ModelSelection | null => {
    if (!serialized) return null;
    try {
      return JSON.parse(serialized) as ModelSelection;
    } catch {
      return null;
    }
  };
  const changeProvider = (
    providerId: string,
    update: (provider: ModelProviderEditor) => ModelProviderEditor,
  ) =>
    onChange({
      ...value,
      providers: value.providers.map((provider) =>
        provider.id === providerId ? update(provider) : provider,
      ),
    });
  const clearSelectionFor = (selection: ModelSelection | null) => {
    const defaultModel =
      selection !== null &&
      value.defaultModel?.providerId === selection.providerId &&
      value.defaultModel.modelId === selection.modelId
        ? null
        : value.defaultModel;
    const taskModels = { ...value.taskModels };
    if (selection !== null) {
      for (const task of LLM_TASKS) {
        const current = taskModels[task.id];
        if (
          current?.providerId === selection.providerId &&
          current.modelId === selection.modelId
        ) {
          taskModels[task.id] = null;
        }
      }
    }
    return { defaultModel, taskModels };
  };
  const addProvider = () =>
    onChange({
      ...value,
      providers: [
        ...value.providers,
        {
          id: `provider-${crypto.randomUUID()}`,
          name: '',
          baseUrl: '',
          apiMode: 'chat',
          apiKey: '',
          hasApiKey: false,
          models: [''],
        },
      ],
    });
  const removeProvider = (providerId: string) => {
    const providers = value.providers.filter((provider) => provider.id !== providerId);
    const defaultModel =
      value.defaultModel?.providerId === providerId ? null : value.defaultModel;
    const taskModels = { ...value.taskModels };
    for (const task of LLM_TASKS) {
      if (taskModels[task.id]?.providerId === providerId) taskModels[task.id] = null;
    }
    onChange({ ...value, providers, defaultModel, taskModels });
  };
  const canSave =
    value.providers.length > 0 &&
    value.defaultModel !== null &&
    value.providers.every(
      (provider) =>
        provider.name.trim() !== '' &&
        provider.baseUrl.trim() !== '' &&
        provider.models.length > 0 &&
        provider.models.every((modelId) => modelId.trim() !== '') &&
        (provider.apiKey.trim() !== '' || provider.hasApiKey),
    );

  return (
    <details className="card model-settings-card">
      <summary className="card-heading model-settings-summary">
        <h2>模型 Provider 与模型</h2>
        <span className="model-settings-summary-meta">
          <span>密钥加密保存</span>
          <Icon name="chevron-down" className="model-settings-toggle-icon" />
        </span>
      </summary>
      <div className="card-body model-settings-body">
        <p className="small muted">
          每个 Provider 配置一次连接地址，可添加多个模型。未指定阶段模型时使用默认模型。
        </p>
        {value.providers.map((provider, providerIndex) => (
          <section className="model-provider-card" key={provider.id}>
            <div className="model-provider-heading">
              <strong>{provider.name || `Provider ${providerIndex + 1}`}</strong>
              <button
                className="button compact"
                onClick={() => removeProvider(provider.id)}
              >
                删除 Provider
              </button>
            </div>
            <div className="model-provider-grid">
              <label className="form-field">
                Provider 名称
                <input
                  value={provider.name}
                  onChange={(event) =>
                    changeProvider(provider.id, (current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  placeholder="例如：OpenAI"
                />
              </label>
              <label className="form-field">
                Base URL
                <input
                  type="url"
                  value={provider.baseUrl}
                  onChange={(event) =>
                    changeProvider(provider.id, (current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="form-field">
                API 模式
                <select
                  value={provider.apiMode}
                  onChange={(event) =>
                    changeProvider(provider.id, (current) => ({
                      ...current,
                      apiMode: event.target.value as 'chat' | 'responses',
                    }))
                  }
                >
                  <option value="chat">Chat Completions</option>
                  <option value="responses">Responses</option>
                </select>
              </label>
              <label className="form-field">
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  value={provider.apiKey}
                  onChange={(event) =>
                    changeProvider(provider.id, (current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }))
                  }
                  placeholder={provider.hasApiKey ? '留空保持当前密钥' : '输入 API Key'}
                />
              </label>
            </div>
            <div className="model-list">
              <strong>模型</strong>
              {provider.models.map((modelId, modelIndex) => (
                <div className="model-list-row" key={`${provider.id}-${modelIndex}`}>
                  <input
                    aria-label={`${provider.name || 'Provider'} 模型 ID`}
                    value={modelId}
                    onChange={(event) => {
                      const previousSelection = modelId
                        ? { providerId: provider.id, modelId }
                        : null;
                      const cleared = clearSelectionFor(previousSelection);
                      onChange({
                        ...value,
                        providers: value.providers.map((current) =>
                          current.id === provider.id
                            ? {
                                ...current,
                                models: current.models.map((item, index) =>
                                  index === modelIndex ? event.target.value : item,
                                ),
                              }
                            : current,
                        ),
                        ...cleared,
                      });
                    }}
                    placeholder="模型 ID，例如 gpt-4.1-mini"
                  />
                  <button
                    className="button compact"
                    disabled={provider.models.length <= 1}
                    onClick={() => {
                      const cleared = clearSelectionFor(
                        modelId ? { providerId: provider.id, modelId } : null,
                      );
                      onChange({
                        ...value,
                        providers: value.providers.map((current) =>
                          current.id === provider.id
                            ? {
                                ...current,
                                models: current.models.filter(
                                  (_, index) => index !== modelIndex,
                                ),
                              }
                            : current,
                        ),
                        ...cleared,
                      });
                    }}
                  >
                    移除
                  </button>
                </div>
              ))}
              <button
                className="button compact"
                onClick={() =>
                  changeProvider(provider.id, (current) => ({
                    ...current,
                    models: [...current.models, ''],
                  }))
                }
              >
                添加模型
              </button>
            </div>
          </section>
        ))}
        <button className="button" onClick={addProvider}>
          添加 Provider
        </button>
        <div className="model-selection-grid">
          <label className="form-field">
            默认模型
            <select
              value={selectionValue(value.defaultModel)}
              onChange={(event) =>
                onChange({ ...value, defaultModel: parseSelection(event.target.value) })
              }
            >
              <option value="">请选择默认模型</option>
              {selections.map((selection) => {
                const provider = value.providers.find(
                  (item) => item.id === selection.providerId,
                );
                return (
                  <option
                    key={selectionValue(selection)}
                    value={selectionValue(selection)}
                  >
                    {provider?.name || 'Provider'} / {selection.modelId}
                  </option>
                );
              })}
            </select>
          </label>
          <div className="model-task-overrides">
            <strong>阶段模型（可选，留空时使用默认模型）</strong>
            {LLM_TASKS.map((task) => (
              <label className="model-task-row" key={task.id}>
                <span>{task.label}</span>
                <select
                  value={selectionValue(value.taskModels[task.id])}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      taskModels: {
                        ...value.taskModels,
                        [task.id]: parseSelection(event.target.value),
                      },
                    })
                  }
                >
                  <option value="">使用默认模型</option>
                  {selections.map((selection) => {
                    const provider = value.providers.find(
                      (item) => item.id === selection.providerId,
                    );
                    return (
                      <option
                        key={selectionValue(selection)}
                        value={selectionValue(selection)}
                      >
                        {provider?.name || 'Provider'} / {selection.modelId}
                      </option>
                    );
                  })}
                </select>
              </label>
            ))}
          </div>
        </div>
        <div className="model-settings-footer">
          <span className="small muted">
            API Key 仅在保存时发送，使用本地加密密钥加密，之后不会再次返回浏览器。
          </span>
          <button
            className="button primary"
            disabled={!canSave || saving}
            onClick={onSave}
          >
            {saving ? '保存中' : '保存模型设置'}
          </button>
        </div>
        <ToastNotice message={message} tone={tone ?? 'info'} />
      </div>
    </details>
  );
}

function ContentPromptSettingsSection({
  value,
  saving,
  message,
  tone,
  onChange,
  onSave,
}: {
  value: ContentPromptsConfig;
  saving: boolean;
  message?: string;
  tone?: 'danger' | 'info' | 'success';
  onChange: (value: ContentPromptsConfig) => void;
  onSave: (value: ContentPromptsConfig) => void;
}) {
  const [selectedPlatformId, setSelectedPlatformId] = useState<Platform>(
    PLATFORM_OPTIONS[0]!.id,
  );
  const [selectedPromptId, setSelectedPromptId] = useState('xhs-default');
  const [draft, setDraft] = useState<{ name: string; content: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const availablePlatforms = useMemo(
    () =>
      PLATFORM_OPTIONS.map((option) => ({
        ...option,
        prompts: value.platforms.find((item) => item.id === option.id)?.prompts ?? [],
      })),
    [value.platforms],
  );
  const platform =
    availablePlatforms.find((item) => item.id === selectedPlatformId) ??
    availablePlatforms[0] ??
    null;
  const prompt = platform?.prompts.find((item) => item.id === selectedPromptId) ?? null;
  const promptDraft = prompt
    ? (draft ?? { name: prompt.name, content: prompt.content })
    : null;
  const dirty =
    prompt !== null &&
    promptDraft !== null &&
    (promptDraft.name !== prompt.name || promptDraft.content !== prompt.content);

  useEffect(() => {
    if (!availablePlatforms.some((item) => item.id === selectedPlatformId)) {
      const nextPlatform = availablePlatforms[0] ?? null;
      if (nextPlatform) setSelectedPlatformId(nextPlatform.id);
      const nextPrompt = nextPlatform?.prompts[0] ?? null;
      setSelectedPromptId(nextPrompt?.id ?? '');
      setDraft(
        nextPrompt ? { name: nextPrompt.name, content: nextPrompt.content } : null,
      );
      return;
    }
    const selected = availablePlatforms
      .find((item) => item.id === selectedPlatformId)
      ?.prompts.find((item) => item.id === selectedPromptId);
    if (!selected) {
      const nextPrompt =
        availablePlatforms.find((item) => item.id === selectedPlatformId)?.prompts[0] ??
        null;
      setSelectedPromptId(nextPrompt?.id ?? '');
      setDraft(
        nextPrompt ? { name: nextPrompt.name, content: nextPrompt.content } : null,
      );
    }
  }, [value, selectedPlatformId, selectedPromptId, availablePlatforms]);

  const persist = (nextValue: ContentPromptsConfig) => {
    onChange(nextValue);
    onSave(nextValue);
  };
  const selectPlatform = (nextPlatform: (typeof availablePlatforms)[number]) => {
    setSelectedPlatformId(nextPlatform.id);
    const nextPrompt = nextPlatform.prompts[0] ?? null;
    setSelectedPromptId(nextPrompt?.id ?? '');
    setDraft(nextPrompt ? { name: nextPrompt.name, content: nextPrompt.content } : null);
    setConfirmDelete(null);
  };
  const selectPrompt = (id: string) => {
    const nextPrompt = platform?.prompts.find((item) => item.id === id) ?? null;
    setSelectedPromptId(id);
    setDraft(nextPrompt ? { name: nextPrompt.name, content: nextPrompt.content } : null);
    setConfirmDelete(null);
  };
  const addPrompt = () => {
    if (!platform) return;
    const nextPrompt = {
      id: `prompt-${crypto.randomUUID()}`,
      name: '未命名提示词',
      content: '',
      active: platform.prompts.length === 0,
    };
    const nextValue = {
      platforms: value.platforms.map((item) =>
        item.id === platform.id
          ? { ...item, prompts: [...item.prompts, nextPrompt] }
          : item,
      ),
    };
    persist(nextValue);
    setSelectedPromptId(nextPrompt.id);
    setDraft({ name: nextPrompt.name, content: nextPrompt.content });
  };
  const removePrompt = () => {
    if (!platform || !prompt) return;
    const prompts = platform.prompts.filter((item) => item.id !== prompt.id);
    if (prompt.active && prompts[0]) prompts[0] = { ...prompts[0], active: true };
    persist({
      platforms: value.platforms.map((item) =>
        item.id === platform.id ? { ...item, prompts } : item,
      ),
    });
    const nextPrompt = prompts[0] ?? null;
    setSelectedPromptId(nextPrompt?.id ?? '');
    setDraft(nextPrompt ? { name: nextPrompt.name, content: nextPrompt.content } : null);
    setConfirmDelete(null);
  };
  const setActive = () => {
    if (!platform || !prompt) return;
    persist({
      platforms: value.platforms.map((item) =>
        item.id === platform.id
          ? {
              ...item,
              prompts: item.prompts.map((entry) => ({
                ...entry,
                active: entry.id === prompt.id,
              })),
            }
          : item,
      ),
    });
  };
  const savePrompt = () => {
    if (!platform || !prompt || !promptDraft) return;
    const name = promptDraft.name.trim() || '未命名提示词';
    const nextPrompt = { ...prompt, name, content: promptDraft.content };
    persist({
      platforms: value.platforms.map((item) =>
        item.id === platform.id
          ? {
              ...item,
              prompts: item.prompts.map((entry) =>
                entry.id === prompt.id ? nextPrompt : entry,
              ),
            }
          : item,
      ),
    });
    setDraft({ name, content: promptDraft.content });
  };

  return (
    <section className="card content-prompts-card">
      <div className="card-heading">
        <h2>内容生成提示词</h2>
        <span>热配置 · 下一次生成生效</span>
      </div>
      <p className="content-prompts-description">
        按平台管理创作提示词。每个平台可以保存多个提示词，其中“使用中”的一个会在下一次生成时生效；已生成的草稿保持原文。输出格式和事实引用要求由系统固定。
      </p>
      <div className="content-prompts-grid">
        <div className="content-prompts-column">
          <div className="content-prompts-column-heading">平台</div>
          {availablePlatforms.map((item) => (
            <div
              className={`content-prompt-item ${item.id === platform?.id ? 'selected' : ''}`}
              key={item.id}
            >
              <button
                className="content-prompt-select"
                onClick={() => selectPlatform(item)}
              >
                <span className="content-prompt-name">{item.name}</span>
                <span className="content-prompt-count">{item.prompts.length}</span>
              </button>
            </div>
          ))}
        </div>
        <div className="content-prompts-column">
          <div className="content-prompts-column-heading">
            <span>{platform ? `${platform.name}的提示词` : '提示词'}</span>
          </div>
          {platform?.prompts.map((item) => (
            <button
              className={`content-prompt-item content-prompt-choice ${item.id === prompt?.id ? 'selected' : ''}`}
              key={item.id}
              onClick={() => selectPrompt(item.id)}
            >
              <span className="content-prompt-name">{item.name || '未命名提示词'}</span>
              {item.active ? <span className="content-prompt-active">使用中</span> : null}
            </button>
          ))}
          {platform ? (
            <button className="content-prompt-add" onClick={addPrompt} disabled={saving}>
              + 新建提示词
            </button>
          ) : null}
        </div>
        <div className="content-prompts-editor">
          {!platform ? (
            <div className="content-prompts-empty">
              还没有平台，先在左侧新增一个平台。
            </div>
          ) : !prompt || !promptDraft ? (
            <div className="content-prompts-empty">
              {platform.name}下还没有提示词。
              <br />
              点击中间的“新建提示词”开始编写。
            </div>
          ) : (
            <>
              <label className="content-prompts-label" htmlFor="content-prompt-name">
                提示词名称
              </label>
              <input
                id="content-prompt-name"
                maxLength={24}
                value={promptDraft.name}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...promptDraft, name: event.target.value })
                }
              />
              <label
                className="content-prompts-label content-prompts-content-label"
                htmlFor="content-prompt-content"
              >
                提示词内容
              </label>
              <textarea
                id="content-prompt-content"
                maxLength={20000}
                value={promptDraft.content}
                disabled={saving}
                onChange={(event) =>
                  setDraft({ ...promptDraft, content: event.target.value })
                }
              />
              <div className="content-prompts-actions">
                <button
                  className={`button danger ${confirmDelete === `prompt-${prompt.id}` ? 'confirm' : ''}`}
                  disabled={saving}
                  onClick={() => {
                    const key = `prompt-${prompt.id}`;
                    if (confirmDelete === key) removePrompt();
                    else setConfirmDelete(key);
                  }}
                >
                  {confirmDelete === `prompt-${prompt.id}` ? '确认删除' : '删除'}
                </button>
                <span className="content-prompts-status">
                  {dirty ? '有未保存的修改' : `${promptDraft.content.length} 字`}
                </span>
                {!prompt.active ? (
                  <button className="button" onClick={setActive} disabled={saving}>
                    设为使用中
                  </button>
                ) : null}
                <button
                  className="button primary"
                  disabled={!dirty || saving}
                  onClick={savePrompt}
                >
                  {saving ? '保存中' : '保存提示词'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="content-prompts-notice">
        <ToastNotice message={message} tone={tone ?? 'info'} />
      </div>
    </section>
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
  type SettingsNotice = {
    message: string;
    tone: 'danger' | 'info' | 'success';
  };
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState('');
  const [contentPrompts, setContentPrompts] = useState<ContentPromptsConfig>(() =>
    contentPromptsFromSettings(),
  );
  const [promptMessage, setPromptMessage] = useState<SettingsNotice | null>(null);
  const [modelMessage, setModelMessage] = useState<SettingsNotice | null>(null);
  const [accountMessage, setAccountMessage] = useState<SettingsNotice | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newAdminUsername, setNewAdminUsername] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [admins, setAdmins] = useState<
    Array<AdminUser & { createdAt: string; updatedAt: string }>
  >([]);
  const [adminsLoading, setAdminsLoading] = useState(user.role === 'SUPER_ADMIN');
  const [adminsError, setAdminsError] = useState('');
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetMode, setResetMode] = useState<'random' | 'specified'>('random');
  const [resetPassword, setResetPassword] = useState('');
  const [maxQueries, setMaxQueries] = useState(5);
  const [minDirectionScore, setMinDirectionScore] = useState(60);
  const [llmModels, setLlmModels] = useState<LlmModelsEditor>({
    providers: [],
    defaultModel: null,
    taskModels: {},
  });
  const [contentCenter, setContentCenter] = useState<ContentCenterConfig>({
    maxUploadBytes: 20 * 1024 * 1024,
    downloadExpiresIn: 300,
    cdnExpiresIn: 0,
  });
  useEffect(() => {
    setLoading(true);
    void api<SettingsData>('/api/v1/settings')
      .then((value) => {
        setData(value);
        setLoadError('');
        const prompts = value.items.find((item) => item.key === 'content_prompts')
          ?.value as ContentPromptsConfig | undefined;
        const legacyPrompt = value.items.find((item) => item.key === 'xiaohongshu_prompt')
          ?.value as { systemPrompt?: string } | undefined;
        setContentPrompts(
          contentPromptsFromSettings(prompts, legacyPrompt?.systemPrompt),
        );
        const budget = value.items.find((item) => item.key === 'search_budget')?.value as
          { maxQueries?: number } | undefined;
        const quality = value.items.find((item) => item.key === 'quality_thresholds')
          ?.value as { minDirectionScore?: number } | undefined;
        setMaxQueries(budget?.maxQueries ?? 5);
        setMinDirectionScore(quality?.minDirectionScore ?? 60);
        const models = value.items.find((item) => item.key === 'llm_models')?.value as
          Partial<LlmModelsEditor> | undefined;
        if (models) {
          setLlmModels({
            providers: (models.providers ?? []).map((provider) => ({
              ...provider,
              apiKey: '',
              hasApiKey: Boolean(provider.hasApiKey),
            })),
            defaultModel: models.defaultModel ?? null,
            taskModels: models.taskModels ?? {},
          });
        }
        const content = value.items.find((item) => item.key === 'content_center')
          ?.value as ContentCenterConfig | undefined;
        if (content) {
          setContentCenter({
            maxUploadBytes: content.maxUploadBytes,
            downloadExpiresIn: content.downloadExpiresIn,
            cdnExpiresIn: content.cdnExpiresIn,
          });
        }
      })
      .catch((reason: unknown) => {
        setData(null);
        setLoadError(reason instanceof Error ? reason.message : '设置加载失败');
      })
      .finally(() => setLoading(false));
  }, []);
  const loadAdmins = useCallback(() => {
    if (user.role !== 'SUPER_ADMIN') return;
    setAdminsLoading(true);
    void api<{ items: Array<AdminUser & { createdAt: string; updatedAt: string }> }>(
      '/api/v1/admin/users',
    )
      .then((value) => {
        setAdmins(value.items);
        setAdminsError('');
      })
      .catch((reason: unknown) => {
        setAdmins([]);
        setAdminsError(reason instanceof Error ? reason.message : '管理员账号加载失败');
      })
      .finally(() => setAdminsLoading(false));
  }, [user.role]);
  useEffect(() => loadAdmins(), [loadAdmins]);
  const changeOwnPassword = () => {
    setAccountMessage(null);
    void api('/api/v1/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
      .then(() => {
        setCurrentPassword('');
        setNewPassword('');
        setAccountMessage({
          message: '密码已修改，其他登录会话已失效',
          tone: 'success',
        });
      })
      .catch((reason: unknown) =>
        setAccountMessage({
          message: reason instanceof Error ? reason.message : '密码修改失败',
          tone: 'danger',
        }),
      );
  };
  const createAdmin = () => {
    setAccountMessage(null);
    void api('/api/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: newAdminUsername, password: newAdminPassword }),
    })
      .then(() => {
        setNewAdminUsername('');
        setNewAdminPassword('');
        setAccountMessage({ message: 'ADMIN 已创建', tone: 'success' });
        loadAdmins();
      })
      .catch((reason: unknown) =>
        setAccountMessage({
          message: reason instanceof Error ? reason.message : '管理员创建失败',
          tone: 'danger',
        }),
      );
  };
  const resetAdminPassword = () => {
    if (resetTarget === null) return;
    setAccountMessage(null);
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
        setAccountMessage({
          message: value.password
            ? `已重置 ${resetTarget.username} 的密码，一次性新密码：${value.password}`
            : `已重置 ${resetTarget.username} 的密码`,
          tone: 'success',
        });
        setResetTarget(null);
        setResetPassword('');
      })
      .catch((reason: unknown) =>
        setAccountMessage({
          message: reason instanceof Error ? reason.message : '密码重置失败',
          tone: 'danger',
        }),
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
        if (key === 'llm_models') {
          const configured = saved.value as LlmModelsEditor;
          setLlmModels({
            ...configured,
            providers: configured.providers.map((provider) => ({
              ...provider,
              apiKey: '',
              hasApiKey: Boolean(provider.hasApiKey),
            })),
          });
        }
        if (key === 'content_prompts') {
          setContentPrompts(saved.value as ContentPromptsConfig);
        }
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
        if (key === 'llm_models')
          setModelMessage({ message: '模型设置已保存', tone: 'success' });
        if (key === 'content_prompts')
          setPromptMessage({
            message: '提示词设置已保存，下次内容生成时生效',
            tone: 'success',
          });
      })
      .catch((error) => {
        setSaving('保存失败');
        const notice = {
          message: error instanceof Error ? error.message : '保存失败',
          tone: 'danger' as const,
        };
        if (key === 'llm_models') setModelMessage(notice);
        else if (key === 'content_prompts') setPromptMessage(notice);
      });
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
  if (loading) {
    return (
      <div className="content">
        <PageHeading
          title="系统设置"
          description="管理非敏感运行参数、平台策略引用和连接健康状态。"
        />
        <LoadingState label="正在加载系统设置…" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="content">
        <PageHeading
          title="系统设置"
          description="管理非敏感运行参数、平台策略引用和连接健康状态。"
        />
        <div className="card empty">{loadError}</div>
      </div>
    );
  }
  return (
    <>
      <div className="content">
        <PageHeading
          title="系统设置"
          description="管理非敏感运行参数、平台策略引用和连接健康状态。"
        />
        {data ? (
          <ModelSettingsSection
            value={llmModels}
            saving={saving === 'llm_models'}
            message={modelMessage?.message}
            tone={modelMessage?.tone}
            onChange={setLlmModels}
            onSave={() => updateSetting('llm_models', llmModels)}
          />
        ) : null}
        {data ? (
          <ContentPromptSettingsSection
            value={contentPrompts}
            saving={saving === 'content_prompts'}
            message={promptMessage?.message}
            tone={promptMessage?.tone}
            onChange={setContentPrompts}
            onSave={(value) => updateSetting('content_prompts', value)}
          />
        ) : null}
        <div className="settings-grid">
          <section className="card">
            <div className="card-heading">
              <h2>非敏感配置</h2>
              <span>密钥只显示状态</span>
            </div>
            <div className="card-body">
              {data ? (
                <>
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
                    <span className="setting-key">内容中心</span>
                    <span className="small muted">
                      令牌由服务端环境变量提供，上传源使用内容中心默认配置，以下参数保存后立即生效
                    </span>
                  </div>
                  <fieldset
                    disabled={user.role !== 'SUPER_ADMIN'}
                    style={{ border: 0, padding: 0, margin: 0 }}
                  >
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
                      <label htmlFor="content-download-expiry">
                        下载链接有效期（秒）
                      </label>
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
                  </fieldset>
                </>
              ) : null}
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
        <div className="account-settings">
          <section className="card account-card password-card">
            <div className="card-heading account-card-heading">
              <div className="account-heading-title">
                <span className="account-heading-icon">
                  <Icon name="key" />
                </span>
                <div>
                  <h2>修改密码</h2>
                  <p>定期更新密码，保护管理账号安全。</p>
                </div>
              </div>
              <span className="status neutral">
                {user.role === 'SUPER_ADMIN' ? '超级管理员' : '管理员'}
              </span>
            </div>
            <div className="card-body">
              <div className="account-identity">
                <span className="admin-avatar">
                  {user.username.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <strong>{user.username}</strong>
                  <span>当前登录账号</span>
                </div>
              </div>
              <div className="account-form-stack">
                <div className="account-field">
                  <label htmlFor="current-admin-password">当前密码</label>
                  <input
                    id="current-admin-password"
                    className="field"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </div>
                <div className="account-field">
                  <label htmlFor="new-admin-password">新密码</label>
                  <input
                    id="new-admin-password"
                    className="field"
                    type="password"
                    autoComplete="new-password"
                    minLength={5}
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    aria-describedby="password-requirement"
                  />
                  <span className="account-field-hint" id="password-requirement">
                    至少 5 位字符
                  </span>
                </div>
                <button
                  className="button primary account-submit"
                  disabled={currentPassword === '' || newPassword.length < 5}
                  onClick={changeOwnPassword}
                >
                  <Icon name="key" />
                  修改密码
                </button>
              </div>
            </div>
          </section>
          {user.role === 'SUPER_ADMIN' ? (
            <section className="card account-card admin-card">
              <div className="card-heading account-card-heading">
                <div className="account-heading-title">
                  <span className="account-heading-icon">
                    <Icon name="users" />
                  </span>
                  <div>
                    <h2>管理员管理</h2>
                    <p>创建管理账号，并为团队成员重置密码。</p>
                  </div>
                </div>
                <span className="status neutral">超级管理员专属</span>
              </div>
              <div className="card-body">
                <div className="admin-create-panel">
                  <div className="admin-create-title">
                    <strong>创建管理员</strong>
                    <span>新账号初始密码至少 5 位</span>
                  </div>
                  <div className="admin-create-editor">
                    <div className="account-field">
                      <label htmlFor="new-admin-username">用户名</label>
                      <input
                        id="new-admin-username"
                        className="field"
                        value={newAdminUsername}
                        onChange={(event) => setNewAdminUsername(event.target.value)}
                        placeholder="输入管理员用户名"
                      />
                    </div>
                    <div className="account-field">
                      <label htmlFor="new-admin-initial-password">初始密码</label>
                      <input
                        id="new-admin-initial-password"
                        className="field"
                        type="password"
                        minLength={5}
                        autoComplete="new-password"
                        value={newAdminPassword}
                        onChange={(event) => setNewAdminPassword(event.target.value)}
                        placeholder="至少 5 位字符"
                      />
                    </div>
                    <button
                      className="button primary admin-create-submit"
                      disabled={
                        newAdminUsername.trim().length < 3 || newAdminPassword.length < 5
                      }
                      onClick={createAdmin}
                    >
                      <Icon name="plus" />
                      创建管理员
                    </button>
                  </div>
                </div>
                <div className="admin-list-heading">
                  <strong>管理员账号</strong>
                  <span>{admins.length} 个账号</span>
                </div>
                <div className="admin-list">
                  {adminsLoading ? <LoadingState label="正在加载管理员账号…" /> : null}
                  {!adminsLoading && adminsError ? (
                    <div className="admin-empty">{adminsError}</div>
                  ) : null}
                  {!adminsLoading
                    ? admins.map((admin) => (
                        <div className="admin-row" key={admin.id}>
                          <span className="admin-avatar">
                            {admin.username.slice(0, 1).toUpperCase()}
                          </span>
                          <div className="admin-row-info">
                            <strong title={admin.username}>{admin.username}</strong>
                            <span>
                              {admin.role === 'SUPER_ADMIN' ? '超级管理员' : '管理员'}
                              {admin.id === user.id ? ' · 当前账号' : ''}
                            </span>
                          </div>
                          {admin.role === 'ADMIN' ? (
                            <button
                              className="button compact"
                              onClick={() => setResetTarget(admin)}
                            >
                              重置密码
                            </button>
                          ) : (
                            <span className="admin-owner-badge">所有者</span>
                          )}
                        </div>
                      ))
                    : null}
                  {!adminsLoading && !adminsError && admins.length === 0 ? (
                    <div className="admin-empty">暂无管理员账号</div>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}
        </div>
        <ToastNotice
          message={accountMessage?.message}
          tone={accountMessage?.tone ?? 'info'}
        />
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
      <ToastNotice message={error} />
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

export default function ConsoleApp() {
  const [location, setLocation] = useState(viewFromLocation);
  const [theme, setTheme] = useTheme();
  const [currentUser, setCurrentUser] = useState<AdminUser | null>();
  const [overview, setOverview] = useState<ApiState>();
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [workflowsRefreshKey, setWorkflowsRefreshKey] = useState(0);
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
    setOverviewLoading(true);
    void api<ApiState>('/api/v1/overview')
      .then((value) => {
        setOverview(value);
        setOverviewError('');
      })
      .catch((reason: unknown) => {
        setOverview(undefined);
        if (reason instanceof ApiError && reason.status === 401) setCurrentUser(null);
        else
          setOverviewError(reason instanceof Error ? reason.message : '概览数据加载失败');
      })
      .finally(() => setOverviewLoading(false));
  }, []);
  useEffect(() => {
    if (currentUser && location.view === 'overview') loadOverview();
  }, [currentUser, location.view, loadOverview]);
  const logout = useCallback(() => {
    void api('/api/v1/auth/logout', { method: 'POST', body: '{}' }).finally(() => {
      setCurrentUser(null);
      setOverview(undefined);
    });
  }, []);
  const create = (input: {
    platform: Platform;
    topic: string;
    directionMode: string;
    publishMode: string;
    accountId: string;
    researchMode: 'search' | 'library' | 'hybrid';
    researchDocumentIds: string[];
  }) => {
    void api('/api/v1/runs', {
      method: 'POST',
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify(input),
    })
      .then(() => {
        setShowCreate(false);
        setWorkflowsRefreshKey((key) => key + 1);
        navigate('workflows');
      })
      .catch(() => undefined);
  };
  if (currentUser === undefined) {
    return (
      <div className="app-loading">
        <LoadingState label="正在加载管理后台…" />
      </div>
    );
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
      <OverviewView
        data={overview}
        loading={overviewLoading}
        error={overviewError}
        onRefresh={loadOverview}
      />
    );
  else if (location.view === 'workflows')
    content = (
      <WorkflowsView
        refreshKey={workflowsRefreshKey}
        onOpen={(id) => navigate(`workflow/${id}`)}
      />
    );
  else if (location.view === 'drafts')
    content = <DraftsView onOpen={(id) => navigate(`draft/${id}`)} />;
  else if (location.view === 'research') content = <ResearchView />;
  else content = <SettingsView user={currentUser} />;
  return (
    <>
      <Shell
        active={showCreate ? 'workflows' : location.view}
        mode={theme}
        onTheme={setTheme}
        onCreate={() => setShowCreate(true)}
        user={currentUser}
        onLogout={logout}
      >
        {showCreate ? (
          <CreateRunModal onClose={() => setShowCreate(false)} onCreate={create} />
        ) : (
          content
        )}
      </Shell>
    </>
  );
}

function CreateRunModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: {
    platform: Platform;
    topic: string;
    directionMode: string;
    publishMode: string;
    accountId: string;
    researchMode: 'search' | 'library' | 'hybrid';
    researchDocumentIds: string[];
  }) => void;
}) {
  type Folder = { id: string; name: string; parentId: string | null };
  type Doc = { id: string; title: string; folderId: string | null };
  type Library = { folders: Folder[]; documents: Doc[] };
  type Node = { id: string; title: string; type: 'folder' | 'file'; children: Node[] };
  const [topic, setTopic] = useState('');
  const [platform, setPlatform] = useState<Platform>(PLATFORM_OPTIONS[0]!.id);
  const [directionMode, setDirectionMode] = useState('manual');
  const [researchMode, setResearchMode] = useState<'search' | 'library' | 'hybrid'>(
    'search',
  );
  const [library, setLibrary] = useState<Library>({ folders: [], documents: [] });
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState('');
  const [researchDocumentIds, setResearchDocumentIds] = useState<string[]>([]);
  const [treeSearch, setTreeSearch] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  useEffect(() => {
    void api<Library>('/api/v1/research-library')
      .then((data) => {
        setLibrary(data);
        setLibraryError('');
        setExpandedFolders(
          new Set(
            data.folders
              .filter((folder) => folder.parentId === null)
              .map((folder) => folder.id),
          ),
        );
      })
      .catch((reason: unknown) =>
        setLibraryError(reason instanceof Error ? reason.message : '研究资料加载失败'),
      )
      .finally(() => setLibraryLoading(false));
  }, []);
  const nodesByParent = new Map<string | null, Node[]>([[null, []]]);
  for (const folder of library.folders) nodesByParent.set(folder.id, []);
  for (const folder of library.folders) {
    const parentNodes = nodesByParent.get(folder.parentId) ?? nodesByParent.get(null)!;
    parentNodes.push({
      id: folder.id,
      title: folder.name,
      type: 'folder',
      children: nodesByParent.get(folder.id)!,
    });
  }
  for (const doc of library.documents) {
    (nodesByParent.get(doc.folderId) ?? nodesByParent.get(null)!).push({
      id: doc.id,
      title: doc.title,
      type: 'file',
      children: [],
    });
  }
  const tree = nodesByParent.get(null) ?? [];
  const allFileIds = library.documents.map((doc) => doc.id);
  const descendants = (node: Node): string[] =>
    node.type === 'file' ? [node.id] : node.children.flatMap(descendants);
  const pathById = new Map<string, string>();
  const indexPaths = (items: Node[], parentPath = '') => {
    for (const node of items) {
      const path = parentPath ? `${parentPath} / ${node.title}` : node.title;
      pathById.set(node.id, node.type === 'file' ? parentPath || '全部资料' : path);
      if (node.type === 'folder') indexPaths(node.children, path);
    }
  };
  indexPaths(tree);
  const fileDocs = library.documents.filter((doc) =>
    researchDocumentIds.includes(doc.id),
  );
  const toggleSelection = (node: Node) => {
    const ids = descendants(node);
    const allSelected =
      ids.length > 0 && ids.every((id) => researchDocumentIds.includes(id));
    setResearchDocumentIds((current) =>
      allSelected
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  };
  const matches = (node: Node, query: string): boolean =>
    node.title.toLowerCase().includes(query) ||
    (node.type === 'folder' && node.children.some((child) => matches(child, query)));
  const renderNode = (node: Node, depth = 0): React.ReactNode => {
    const query = treeSearch.trim().toLowerCase();
    if (query && !matches(node, query)) return null;
    const isFolder = node.type === 'folder';
    const ids = isFolder ? descendants(node) : [node.id];
    const checkedCount = ids.filter((id) => researchDocumentIds.includes(id)).length;
    const checked = ids.length > 0 && checkedCount === ids.length;
    const indeterminate = checkedCount > 0 && !checked;
    const expanded = query !== '' || expandedFolders.has(node.id);
    return (
      <Fragment key={node.id}>
        <div
          className="workflow-tree-row"
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isFolder ? expanded : undefined}
          style={{ paddingLeft: 10 + depth * 19 }}
        >
          {isFolder ? (
            <button
              className="workflow-tree-chevron"
              aria-label={expanded ? `收起${node.title}` : `展开${node.title}`}
              onClick={() =>
                setExpandedFolders((current) => {
                  const next = new Set(current);
                  if (expanded) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            >
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            </button>
          ) : (
            <span className="workflow-tree-chevron-spacer" />
          )}
          <input
            type="checkbox"
            checked={checked}
            ref={(element) => {
              if (element) element.indeterminate = indeterminate;
            }}
            onChange={() => toggleSelection(node)}
            aria-label={`选择${node.title}`}
          />
          <Icon name={isFolder ? 'folder' : 'file'} />
          <span className="workflow-tree-label" title={node.title}>
            {node.title}
          </span>
          {isFolder ? <span className="workflow-tree-count">{ids.length}</span> : null}
        </div>
        {isFolder && expanded
          ? node.children.map((child) => renderNode(child, depth + 1))
          : null}
      </Fragment>
    );
  };
  const publishMode = 'review';
  const accountId = '00000000-0000-4000-8000-000000000001';
  const noDocs = library.documents.length === 0;
  const sourceSummary =
    researchMode === 'search'
      ? '联网检索'
      : `已选择 ${researchDocumentIds.length} 篇研究资料${researchMode === 'hybrid' ? ' · 联网检索' : ''}`;
  return (
    <div className="workflow-create-page">
      <div className="workflow-create-content">
        <div className="workflow-prototype-breadcrumb">
          内容工作台 <Icon name="chevron-right" /> 工作流 <Icon name="chevron-right" />{' '}
          <strong>新建工作流</strong>
        </div>
        <div className="workflow-create-heading">
          <div>
            <h2>新建工作流</h2>
            <p>配置内容主题与参考资料，创建后即可开始内容生产。</p>
          </div>
          <button className="button" onClick={onClose}>
            返回
          </button>
        </div>
        <div className="workflow-create-canvas">
          <section className="workflow-create-section">
            <div className="workflow-section-heading">
              <span>01</span>
              <strong>基础设置</strong>
              <small>确定本次内容生产的主题与目标平台</small>
            </div>
            <label className="workflow-field-label" htmlFor="run-topic">
              内容主题<span>*</span>
            </label>
            <input
              className="workflow-topic-input"
              id="run-topic"
              maxLength={150}
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="例如：PostgreSQL 17 升级注意事项"
              autoComplete="off"
            />
            {!topic.trim() ? (
              <small className="workflow-field-hint">请输入本次内容生产的主题。</small>
            ) : null}
            <div className="workflow-platform-label">
              发布平台<span>*</span>
            </div>
            <div className="workflow-platform-row">
              {PLATFORM_OPTIONS.map((option) => (
                <button
                  className={`workflow-platform-selected ${platform === option.id ? 'active' : ''}`}
                  key={option.id}
                  type="button"
                  aria-pressed={platform === option.id}
                  onClick={() => setPlatform(option.id)}
                >
                  <span className="workflow-xhs-mark">{option.name.slice(0, 2)}</span>
                  <span>
                    <strong>{option.name}</strong>
                    <small>{option.contentType}</small>
                  </span>
                  {platform === option.id ? (
                    <span className="workflow-platform-check">✓</span>
                  ) : null}
                </button>
              ))}
              {PLATFORM_OPTIONS.length === 1 ? (
                <button
                  className="workflow-platform-add"
                  type="button"
                  onClick={() => window.alert('更多发布平台将陆续接入')}
                >
                  ＋ 更多平台即将接入
                </button>
              ) : null}
            </div>
            <div className="workflow-create-two-columns">
              <label className="workflow-field-label">
                方向选择
                <select
                  className="workflow-select"
                  value={directionMode}
                  onChange={(event) => setDirectionMode(event.target.value)}
                >
                  <option value="manual">人工选择</option>
                  <option value="auto">自动推荐</option>
                </select>
                <small>
                  {directionMode === 'manual'
                    ? '根据研究资料生成内容方向，进入草稿箱后由你确认。'
                    : '系统结合主题与资料自动推荐方向并继续生成。'}
                </small>
              </label>
              <label className="workflow-field-label">
                资料来源
                <select
                  className="workflow-select"
                  value={researchMode}
                  onChange={(event) =>
                    setResearchMode(event.target.value as 'search' | 'library' | 'hybrid')
                  }
                >
                  <option value="search">仅联网检索</option>
                  <option value="library">资料库</option>
                  <option value="hybrid">混合（资料库 + 联网检索）</option>
                </select>
                <small>
                  {researchMode === 'library'
                    ? '只使用你选中的研究资料作为参考。'
                    : researchMode === 'hybrid'
                      ? '优先参考选中资料，同时补充联网搜索结果。'
                      : '根据主题进行联网检索，无需选择资料。'}
                </small>
              </label>
            </div>
          </section>
          <section className="workflow-create-section workflow-library-section">
            <div className="workflow-section-heading">
              <span>02</span>
              <strong>选择研究资料</strong>
              <small>从资料库中选择文件夹或单篇资料</small>
            </div>
            {researchMode === 'search' ? (
              <div className="workflow-source-hidden">
                <Icon name="info" />
                当前选择“仅联网检索”，无需选择研究资料。切换资料来源后可继续选择。
              </div>
            ) : (
              <>
                {libraryLoading ? <LoadingState label="正在加载研究资料…" /> : null}
                {!libraryLoading && libraryError ? (
                  <div className="workflow-library-empty">{libraryError}</div>
                ) : null}
                {!libraryLoading && !libraryError ? (
                  <>
                    <div className="workflow-selection-intro">
                      <strong>研究资料库</strong>
                      <span>勾选文件夹可选中其下全部资料</span>
                    </div>
                    <div className="workflow-picker">
                      <div className="workflow-picker-left">
                        <div className="workflow-picker-header">
                          <Icon name="folder" />
                          <strong>全部资料</strong>
                          <span>{library.documents.length} 篇</span>
                          <button
                            onClick={() =>
                              setResearchDocumentIds(
                                researchDocumentIds.length === allFileIds.length
                                  ? []
                                  : allFileIds,
                              )
                            }
                          >
                            {allFileIds.length > 0 &&
                            researchDocumentIds.length === allFileIds.length
                              ? '取消全选'
                              : '全选'}
                          </button>
                        </div>
                        <div className="workflow-tree-search">
                          <input
                            aria-label="搜索文件夹或资料名称"
                            value={treeSearch}
                            onChange={(event) => setTreeSearch(event.target.value)}
                            placeholder="搜索文件夹或资料名称"
                          />
                          <button
                            disabled={!treeSearch}
                            onClick={() => setTreeSearch('')}
                          >
                            ×
                          </button>
                        </div>
                        <div className="workflow-tree-tools">
                          <span>资料库 / 全部资料</span>
                          <button
                            disabled={library.folders.length === 0}
                            onClick={() =>
                              setExpandedFolders(
                                library.folders.length > 0 &&
                                  library.folders.every((folder) =>
                                    expandedFolders.has(folder.id),
                                  )
                                  ? new Set()
                                  : new Set(library.folders.map((folder) => folder.id)),
                              )
                            }
                          >
                            {library.folders.length > 0 &&
                            library.folders.every((folder) =>
                              expandedFolders.has(folder.id),
                            )
                              ? '全部收起'
                              : '全部展开'}
                          </button>
                        </div>
                        <div
                          className="workflow-tree"
                          role="tree"
                          aria-label="研究资料库文件树"
                        >
                          {treeSearch.trim() &&
                          !tree.some((node) =>
                            matches(node, treeSearch.trim().toLowerCase()),
                          ) ? (
                            <div className="workflow-tree-empty">没有找到匹配的资料</div>
                          ) : (
                            tree.map((node) => renderNode(node))
                          )}
                        </div>
                      </div>
                      <div className="workflow-picker-right">
                        <div className="workflow-picker-header">
                          <Icon name="draft" />
                          <strong>已选择</strong>
                          <span>{fileDocs.length} 篇</span>
                          <button
                            disabled={!fileDocs.length}
                            onClick={() => setResearchDocumentIds([])}
                          >
                            清空选择
                          </button>
                        </div>
                        <p className="workflow-selected-note">
                          {fileDocs.length
                            ? '所选资料将用于本次内容生成'
                            : '还没有选择任何资料'}
                        </p>
                        <div className="workflow-selected-list">
                          {fileDocs.length ? (
                            fileDocs.map((doc) => (
                              <div className="workflow-selected-item" key={doc.id}>
                                <span className="workflow-file-mark">MD</span>
                                <span>
                                  <strong>{doc.title}</strong>
                                  <small>{pathById.get(doc.id) ?? '全部资料'}</small>
                                </span>
                                <button
                                  aria-label={`移除${doc.title}`}
                                  onClick={() =>
                                    setResearchDocumentIds((current) =>
                                      current.filter((id) => id !== doc.id),
                                    )
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            ))
                          ) : (
                            <div className="workflow-selected-empty">
                              <span>▧</span>
                              <strong>尚未选择资料</strong>
                              <small>从左侧勾选文件夹或资料</small>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="workflow-optional-note">
                      <Icon name="info" />
                      仅勾选资料会作为生成参考；未勾选的资料不会加入本次工作流。
                    </div>
                    {noDocs ? (
                      <div className="workflow-library-empty">
                        资料库暂无内容，请先到“研究资料”创建 Markdown 资料。
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </section>
        </div>
      </div>
      <footer className="workflow-create-page-footer">
        <div className="workflow-create-footer">
          <div className="workflow-create-summary">
            <Icon name="draft" />
            <span>
              {PLATFORM_OPTIONS.find((option) => option.id === platform)?.name} ·{' '}
              {sourceSummary}
            </span>
          </div>
          <div className="workflow-create-actions">
            <button className="button" onClick={onClose}>
              取消
            </button>
            <button
              className="button primary"
              disabled={
                topic.trim() === '' ||
                (researchMode !== 'search' && researchDocumentIds.length === 0)
              }
              onClick={() =>
                onCreate({
                  platform,
                  topic,
                  directionMode,
                  publishMode,
                  accountId,
                  researchMode,
                  researchDocumentIds:
                    researchMode === 'search' ? [] : researchDocumentIds,
                })
              }
            >
              <Icon name="play" />
              创建并开始
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
