'use client';

import { Icon } from '@tutor-flow/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatTokenCount } from './number-format.js';
import { LoadingState } from './loading-state.js';
import { ToastNotice } from './toast.js';

type StepAttempt = {
  id: string;
  stepType: string;
  attemptNo: number;
  status: string;
  outputRef?: string | null;
  errorCategory?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type WorkflowDetail = {
  runId: string;
  topic: string;
  status: string;
  platform: string;
  directionMode: string;
  currentStepType?: string | null;
  selectedDirectionId?: string | null;
  cancelRequested: boolean;
  humanGuidance?: string;
  createdAt: string;
  updatedAt: string;
  usage?: {
    searchQueries: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  steps: StepAttempt[];
  directions: Array<{
    id: string;
    title: string;
    summary: string;
    targetAudience: string;
    keywords: string[];
    totalScore: number;
    rank: number;
  }>;
  outputs?: {
    queryPlans: Array<{
      id: string;
      queries: Array<{ query: string; language: string; intent: string }>;
      model: string;
      promptVersion: string;
      usage: { promptTokens?: number; completionTokens?: number };
      partialFailures?: Array<{ phase?: string; query?: string; reason: string }> | null;
    }>;
    sources: Array<{
      id: string;
      title: string;
      canonicalUrl: string;
      domain: string;
      fetchStatus: string;
      fetchNote?: string | null;
      totalScore?: number | null;
      isPrimary: boolean;
      cluster?: { method: string; similarity: number | null } | null;
    }>;
    claims: Array<{
      id: string;
      statement: string;
      confidence: number;
      sourceIds: string[];
    }>;
    artifacts: Array<{
      id: string;
      kind: string;
      version: number;
      title?: string | null;
      body: string;
      tags: string[];
      generation?: {
        provider?: string;
        model?: string;
        promptVersion?: string;
        tokenUsage?: { promptTokens?: number; completionTokens?: number };
      } | null;
    }>;
    draft?: {
      revision: number;
      status: string;
      title: string;
      body: string;
      tags: string[];
    } | null;
  };
  events: Array<{ id: number; name: string; occurredAt: string; payload: unknown }>;
};

const STAGES = [
  {
    title: '研究资料',
    steps: [
      'QUERY_PLANNING',
      'SEARCH',
      'FETCH_SOURCES',
      'DEDUPE_SOURCES',
      'SCORE_SOURCES',
      'EXTRACT_CLAIMS',
    ],
  },
  { title: '确定方向', steps: ['GENERATE_DIRECTIONS', 'SELECT_DIRECTION'] },
  { title: '生成内容', steps: ['GENERATE_CANONICAL', 'ADAPT_XIAOHONGSHU'] },
  { title: '审核入箱', steps: ['MODERATE_CONTENT', 'CREATE_DRAFT'] },
] as const;

const STEP_NAMES: Record<string, string> = {
  QUERY_PLANNING: '规划搜索词',
  SEARCH: '检索来源',
  FETCH_SOURCES: '抓取原文',
  DEDUPE_SOURCES: '来源去重',
  SCORE_SOURCES: '来源评分',
  EXTRACT_CLAIMS: '提取事实',
  GENERATE_DIRECTIONS: '生成选题方向',
  SELECT_DIRECTION: '确定内容方向',
  GENERATE_CANONICAL: '生成事实初稿',
  ADAPT_XIAOHONGSHU: '生成小红书稿',
  MODERATE_CONTENT: '内容校验',
  CREATE_DRAFT: '创建待审草稿',
};

const STATUS_NAMES: Record<string, string> = {
  QUEUED: '排队中',
  RESEARCHING: '研究中',
  WAITING_DIRECTION: '等待选向',
  GENERATING: '生成中',
  MODERATING: '校验中',
  NEEDS_REVIEW: '等待审核',
  NEEDS_HUMAN: '需要处理',
  RETRY_WAIT: '等待重试',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  PENDING: '等待执行',
  RUNNING: '执行中',
};

function time(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function latestAttempt(
  detail: WorkflowDetail,
  stepType: string,
): StepAttempt | undefined {
  return detail.steps
    .filter((item) => item.stepType === stepType)
    .sort((a, b) => b.attemptNo - a.attemptNo)[0];
}

function attemptDuration(attempt?: StepAttempt): string | null {
  if (!attempt?.startedAt || !attempt.finishedAt) return null;
  const duration =
    new Date(attempt.finishedAt).getTime() - new Date(attempt.startedAt).getTime();
  if (!Number.isFinite(duration) || duration < 0) return null;
  if (duration < 1000) return Math.round(duration) + ' ms';
  if (duration < 60_000) return (duration / 1000).toFixed(1).replace(/\.0$/, '') + ' s';
  return (duration / 60_000).toFixed(1).replace(/\.0$/, '') + ' min';
}

function stepState(detail: WorkflowDetail, stepType: string): string {
  const attempt = latestAttempt(detail, stepType);
  if (attempt) return attempt.status;
  if (stepType === 'SELECT_DIRECTION') {
    if (detail.selectedDirectionId) return 'SUCCEEDED';
    if (detail.status === 'WAITING_DIRECTION') return 'RUNNING';
  }
  if (
    detail.currentStepType === stepType &&
    !['NEEDS_HUMAN', 'FAILED', 'CANCELLED'].includes(detail.status)
  )
    return 'RUNNING';
  return 'PENDING';
}

function stepSummary(detail: WorkflowDetail, stepType: string): string {
  const output = detail.outputs;
  if (!output) return '等待阶段输出';
  if (stepType === 'QUERY_PLANNING')
    return output.queryPlans.length
      ? String(output.queryPlans.at(-1)?.queries.length ?? 0) + ' 条搜索词'
      : '等待查询计划';
  if (stepType === 'SEARCH') return String(output.sources.length) + ' 个召回来源';
  if (stepType === 'FETCH_SOURCES')
    return (
      String(output.sources.filter((item) => item.fetchStatus === 'FETCHED').length) +
      ' 个已抓取来源'
    );
  if (stepType === 'DEDUPE_SOURCES')
    return String(output.sources.filter((item) => item.cluster).length) + ' 个聚类来源';
  if (stepType === 'SCORE_SOURCES')
    return (
      String(output.sources.filter((item) => item.totalScore != null).length) +
      ' 个已评分来源'
    );
  if (stepType === 'EXTRACT_CLAIMS') return String(output.claims.length) + ' 条事实';
  if (stepType === 'GENERATE_DIRECTIONS')
    return String(detail.directions.length) + ' 个候选方向';
  if (stepType === 'SELECT_DIRECTION')
    return (
      detail.directions.find((item) => item.id === detail.selectedDirectionId)?.title ??
      '等待确定方向'
    );
  if (stepType === 'GENERATE_CANONICAL')
    return (
      output.artifacts.find((item) => item.kind === 'CANONICAL')?.title ?? '等待初稿'
    );
  if (stepType === 'ADAPT_XIAOHONGSHU')
    return (
      output.artifacts.find((item) => item.kind === 'XIAOHONGSHU')?.title ??
      '等待小红书稿'
    );
  if (stepType === 'CREATE_DRAFT') return output.draft?.title ?? '等待草稿';
  return STATUS_NAMES[stepState(detail, stepType)] ?? '等待执行';
}

function eventTitle(event: WorkflowDetail['events'][number]): string {
  const payload =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : {};
  const step =
    typeof payload['stepType'] === 'string'
      ? (STEP_NAMES[payload['stepType']] ?? payload['stepType'])
      : '步骤';
  if (event.name === 'run.created') return '任务已创建';
  if (event.name === 'step.completed') return step + '已完成';
  if (event.name === 'step.failed') return step + '执行失败';
  if (event.name === 'run.status_changed')
    return (
      '状态更新：' +
      (STATUS_NAMES[String(payload['to'])] ?? String(payload['to'] ?? '处理中'))
    );
  if (event.name === 'run.direction_selected') return '已确定内容方向';
  if (event.name === 'run.cancelled') return '任务已取消';
  return event.name;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });
  const result = (await response.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!response.ok)
    throw new Error(result?.error ?? '请求失败（' + response.status + '）');
  return result as T;
}

function StepOutput({
  detail,
  stepType,
  selected,
  onSelect,
  onChoose,
}: {
  detail: WorkflowDetail;
  stepType: string;
  selected: string;
  onSelect: (id: string) => void;
  onChoose: () => void;
}) {
  const outputs = detail.outputs;
  const sources = outputs?.sources ?? [];
  const claims = outputs?.claims ?? [];
  const plans = outputs?.queryPlans ?? [];
  const artifacts = outputs?.artifacts ?? [];
  if (stepType === 'QUERY_PLANNING') {
    const plan = plans.at(-1);
    return plan ? (
      <div className="flow-output-stack">
        <p className="flow-output-meta">
          模型 {plan.model} · 提示词版本 {plan.promptVersion} · 输入{' '}
          {plan.usage?.promptTokens ?? 0} / 输出 {plan.usage?.completionTokens ?? 0} Token
        </p>
        <ol className="flow-query-list">
          {plan.queries.map((query, index) => (
            <li key={index}>
              <strong>{query.query}</strong>
              <span>
                {query.language} · {query.intent}
              </span>
            </li>
          ))}
        </ol>
        {(plan.partialFailures ?? []).map((failure, index) => (
          <div className="flow-inline-error" key={index}>
            {failure.query ?? failure.phase ?? '部分失败'}：{failure.reason}
          </div>
        ))}
      </div>
    ) : (
      <p className="flow-empty">
        查询计划尚未生成。完成后会在这里显示每条搜索词和模型用量。
      </p>
    );
  }
  if (['SEARCH', 'FETCH_SOURCES', 'DEDUPE_SOURCES', 'SCORE_SOURCES'].includes(stepType)) {
    return sources.length ? (
      <div className="flow-output-stack">
        <div className="flow-mini-stats">
          <span>召回 {sources.length}</span>
          <span>
            抓取成功 {sources.filter((item) => item.fetchStatus === 'FETCHED').length}
          </span>
          <span>
            抓取失败 {sources.filter((item) => item.fetchStatus === 'FAILED').length}
          </span>
        </div>
        <div className="flow-source-list">
          {sources.map((source) => (
            <div className="flow-source" key={source.id}>
              <div>
                <a href={source.canonicalUrl} target="_blank" rel="noopener noreferrer">
                  {source.title || source.domain}
                </a>
                <small>
                  {source.domain} · {source.isPrimary ? '主要来源' : '一般来源'}
                </small>
              </div>
              <div className="flow-source-side">
                <span
                  className={
                    'flow-pill ' +
                    (source.fetchStatus === 'FAILED'
                      ? 'danger'
                      : source.fetchStatus === 'FETCHED'
                        ? 'success'
                        : '')
                  }
                >
                  {source.fetchStatus === 'FETCHED'
                    ? '已抓取'
                    : source.fetchStatus === 'FAILED'
                      ? '抓取失败'
                      : '待抓取'}
                </span>
                {source.totalScore != null ? (
                  <strong>{source.totalScore.toFixed(1)} 分</strong>
                ) : null}
              </div>
              {source.cluster ? (
                <small>
                  重复来源：{source.cluster.method}
                  {source.cluster.similarity != null
                    ? ' · 相似度 ' + source.cluster.similarity.toFixed(2)
                    : ''}
                </small>
              ) : null}
              {source.fetchNote ? (
                <p className="flow-inline-error">{source.fetchNote}</p>
              ) : null}
            </div>
          ))}
        </div>
        {stepType === 'FETCH_SOURCES' ? (
          <p className="flow-caption">
            网页正文只在处理期间临时缓存；核验后的事实会显示在下一阶段。
          </p>
        ) : null}
      </div>
    ) : (
      <p className="flow-empty">
        来源尚未召回。搜索完成后会显示每个页面的抓取状态、评分和失败原因。
      </p>
    );
  }
  if (stepType === 'EXTRACT_CLAIMS')
    return claims.length ? (
      <div className="flow-output-stack">
        {claims.map((claim, index) => (
          <div className="flow-claim" key={claim.id}>
            <span className="flow-number">{index + 1}</span>
            <div>
              <strong>{claim.statement}</strong>
              <small>
                置信度 {(claim.confidence * 100).toFixed(0)}% · {claim.sourceIds.length}{' '}
                个来源
              </small>
              <div className="flow-claim-sources">
                {claim.sourceIds.map((sourceId) => {
                  const source = sources.find((item) => item.id === sourceId);
                  return source ? (
                    <a
                      key={sourceId}
                      href={source.canonicalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.title || source.domain}
                    </a>
                  ) : null;
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <p className="flow-empty">事实尚未提取。每条事实都会显示其来源和置信度。</p>
    );
  if (['GENERATE_DIRECTIONS', 'SELECT_DIRECTION'].includes(stepType))
    return detail.directions.length ? (
      <div className="flow-output-stack">
        <div className="flow-direction-list">
          {detail.directions.map((direction) => (
            <button
              className={
                'flow-direction ' +
                ((selected || detail.selectedDirectionId) === direction.id
                  ? 'selected'
                  : '')
              }
              key={direction.id}
              onClick={() => onSelect(direction.id)}
              disabled={detail.status !== 'WAITING_DIRECTION'}
            >
              <span>
                方向 {direction.rank} · {direction.totalScore.toFixed(1)} 分
              </span>
              <strong>{direction.title}</strong>
              <p>{direction.summary}</p>
              <small>
                面向 {direction.targetAudience} · {direction.keywords.join(' / ')}
              </small>
            </button>
          ))}
        </div>
        {detail.status === 'WAITING_DIRECTION' ? (
          <button className="button primary" disabled={!selected} onClick={onChoose}>
            确认所选方向
          </button>
        ) : null}
      </div>
    ) : (
      <p className="flow-empty">候选方向尚未生成。</p>
    );
  if (['GENERATE_CANONICAL', 'ADAPT_XIAOHONGSHU'].includes(stepType)) {
    const artifact = artifacts
      .filter(
        (item) =>
          item.kind === (stepType === 'GENERATE_CANONICAL' ? 'CANONICAL' : 'XIAOHONGSHU'),
      )
      .at(-1);
    return artifact ? (
      <article className="flow-article">
        <div className="flow-article-meta">
          版本 {artifact.version} · {artifact.generation?.model ?? '模型未知'} · 提示词{' '}
          {artifact.generation?.promptVersion ?? '—'}
        </div>
        <h3>{artifact.title}</h3>
        <div className="flow-article-body">{artifact.body}</div>
        {artifact.tags.length ? (
          <p className="flow-tags">
            {artifact.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </p>
        ) : null}
      </article>
    ) : (
      <p className="flow-empty">
        内容尚未生成。生成后可在此查看完整标题、正文、标签和模型版本。
      </p>
    );
  }
  if (stepType === 'CREATE_DRAFT')
    return outputs?.draft ? (
      <div className="flow-output-stack">
        <p>
          草稿修订 {outputs.draft.revision} · {outputs.draft.status}
        </p>
        <h3>{outputs.draft.title}</h3>
        <div className="flow-article-body">{outputs.draft.body}</div>
        <button
          className="button primary"
          onClick={() => {
            window.history.pushState(
              {},
              '',
              '/?view=' + encodeURIComponent('draft/' + detail.runId),
            );
            window.dispatchEvent(new PopStateEvent('popstate'));
          }}
        >
          打开草稿箱审核
        </button>
      </div>
    ) : (
      <p className="flow-empty">待审草稿尚未创建。</p>
    );
  return (
    <p className="flow-empty">
      {stepState(detail, stepType) === 'SUCCEEDED'
        ? '内容校验已通过，可继续进入草稿箱。'
        : '校验结果会在本步骤完成后显示；失败时会列出具体原因。'}
    </p>
  );
}

export function WorkflowDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [focusedStep, setFocusedStep] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const chainBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFocusedStep(null);
    setSelected('');
    setDetail(null);
    setError('');
    setLoading(true);
  }, [id]);
  const load = useCallback(() => {
    setLoading(true);
    void request<WorkflowDetail>('/api/v1/runs/' + id)
      .then((value) => {
        setDetail(value);
        setError('');
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '任务加载失败'),
      )
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!detail || focusedStep !== null) return;
    const lastAttemptedStep = [...detail.steps].sort(
      (a, b) =>
        new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime(),
    )[0]?.stepType;
    const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.status);
    const followedStep =
      (isTerminal ? lastAttemptedStep : detail.currentStepType) ??
      lastAttemptedStep ??
      'QUERY_PLANNING';
    const scrollBody = chainBodyRef.current;
    const step = scrollBody?.querySelector<HTMLElement>(
      `[data-step-type="${followedStep}"]`,
    );
    if (!scrollBody || !step) return;
    const bodyRect = scrollBody.getBoundingClientRect();
    const stepRect = step.getBoundingClientRect();
    if (stepRect.top < bodyRect.top) {
      scrollBody.scrollTop -= bodyRect.top - stepRect.top;
    } else if (stepRect.bottom > bodyRect.bottom) {
      scrollBody.scrollTop += stepRect.bottom - bodyRect.bottom;
    }
  }, [detail, focusedStep]);
  const act = (path: string, body: object, message: string) => {
    setError('');
    void request('/api/v1/runs/' + id + path, {
      method: 'POST',
      body: JSON.stringify(body),
    })
      .then(load)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : message),
      );
  };
  if (!detail)
    return (
      <>
        <div className="content">
          <button className="button" onClick={onBack}>
            <Icon name="back" /> 返回工作流
          </button>
          {loading ? (
            <LoadingState label="正在加载任务…" />
          ) : (
            <div className="card empty">{error || '未找到任务'}</div>
          )}
        </div>
        <ToastNotice message={error} />
      </>
    );

  const lastAttemptedStep = [...detail.steps].sort(
    (a, b) => new Date(b.startedAt ?? 0).getTime() - new Date(a.startedAt ?? 0).getTime(),
  )[0]?.stepType;
  const isTerminal = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.status);
  const current =
    focusedStep ??
    (isTerminal ? lastAttemptedStep : detail.currentStepType) ??
    lastAttemptedStep ??
    'QUERY_PLANNING';
  const isFollowing = focusedStep === null;
  const attempt = latestAttempt(detail, current);
  const completed = STAGES.flatMap((stage) => stage.steps).filter(
    (step) => stepState(detail, step) === 'SUCCEEDED',
  ).length;
  const failed = detail.steps
    .filter((step) => step.status === 'FAILED')
    .sort(
      (a, b) =>
        new Date(b.finishedAt ?? b.startedAt ?? 0).getTime() -
        new Date(a.finishedAt ?? a.startedAt ?? 0).getTime(),
    )[0];
  const currentName = STEP_NAMES[detail.currentStepType ?? ''] ?? '等待下一步';
  const positionName =
    detail.status === 'CANCELLED'
      ? '停在：' + currentName
      : detail.status === 'SUCCEEDED'
        ? '流程已结束'
        : currentName;
  const statusHint =
    detail.status === 'WAITING_DIRECTION'
      ? '研究已完成，请在方向阶段选择一个候选选题。'
      : detail.status === 'NEEDS_REVIEW'
        ? '内容已生成，打开草稿箱完成审核。'
        : detail.status === 'NEEDS_HUMAN' || detail.status === 'FAILED'
          ? (failed?.errorMessage ?? detail.humanGuidance ?? '请查看失败步骤。')
          : detail.status === 'SUCCEEDED'
            ? '此任务已完成。'
            : detail.status === 'CANCELLED'
              ? '任务已取消。已保存的阶段输出仍可在下方查看。'
              : '当前正在' + currentName + '；下方会按阶段展示已保存的输出。';
  return (
    <div className="content flow-page">
      <div className="flow-header">
        <div>
          <div className="flow-eyebrow">内容生产流程 · {detail.runId.slice(0, 8)}</div>
          <h1>{detail.topic || '未命名任务'}</h1>
          <p>
            创建于 {time(detail.createdAt)} · 更新于 {time(detail.updatedAt)} · 每 5
            秒自动刷新
          </p>
        </div>
        <div className="actions">
          <button className="button" onClick={onBack}>
            <Icon name="back" /> 返回
          </button>
          <button className="button" onClick={load}>
            {loading ? (
              <span
                className="loading-spinner loading-spinner-small"
                aria-hidden="true"
              />
            ) : (
              <Icon name="retry" />
            )}{' '}
            刷新
          </button>
          {['FAILED', 'NEEDS_HUMAN'].includes(detail.status) ? (
            <button
              className="button primary"
              onClick={() => act('/retry', { reason: '管理台安全重试' }, '重试失败')}
            >
              <Icon name="retry" /> 安全重试
            </button>
          ) : null}
          {!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(detail.status) ? (
            <button
              className="button danger"
              onClick={() => act('/cancel', {}, '取消失败')}
            >
              取消运行
            </button>
          ) : null}
        </div>
      </div>
      <section className="flow-overview card">
        <div className="flow-current">
          <span className="flow-eyebrow">当前状态</span>
          <div className="flow-current-line">
            <strong>{STATUS_NAMES[detail.status] ?? detail.status}</strong>
            <span className="flow-pill">{positionName}</span>
          </div>
          <p>{statusHint}</p>
          {detail.cancelRequested && detail.status !== 'CANCELLED' ? (
            <small>取消请求已提交，等待当前步骤结束。</small>
          ) : null}
        </div>
        <div className="flow-overview-metrics">
          <div>
            <strong>
              {completed}
              <small> / {STAGES.flatMap((stage) => stage.steps).length}</small>
            </strong>
            <span>已完成步骤</span>
          </div>
          <div>
            <strong>{detail.outputs?.sources.length ?? 0}</strong>
            <span>检索来源</span>
          </div>
          <div>
            <strong>{detail.outputs?.claims.length ?? 0}</strong>
            <span>核验事实</span>
          </div>
          <div>
            <strong>{formatTokenCount(detail.usage?.totalTokens ?? 0)}</strong>
            <span>模型 Token</span>
          </div>
        </div>
      </section>
      <div className="flow-phase-strip">
        {STAGES.map((stage, index) => {
          const done = stage.steps.every(
            (step) => stepState(detail, step) === 'SUCCEEDED',
          );
          const active =
            !isTerminal &&
            (stage.steps.includes(detail.currentStepType as never) ||
              (index === 1 && detail.status === 'WAITING_DIRECTION') ||
              (index === 3 && detail.status === 'NEEDS_REVIEW'));
          const stopped =
            isTerminal &&
            !done &&
            (stage.steps.some((step) =>
              detail.steps.some((item) => item.stepType === step),
            ) ||
              stage.steps.includes(detail.currentStepType as never));
          return (
            <div
              className={'flow-phase ' + (done ? 'done' : active ? 'active' : '')}
              key={stage.title}
            >
              <span>{index + 1}</span>
              <strong>{stage.title}</strong>
              <small>
                {done ? '已完成' : active ? '进行中' : stopped ? '已停止' : '未开始'}
              </small>
            </div>
          );
        })}
      </div>
      <div className="flow-workspace">
        <section className="card flow-chain">
          <div className="card-heading">
            <div className="flow-chain-heading-main">
              <h2>流程步骤</h2>
              <button
                type="button"
                className={'flow-follow-button ' + (isFollowing ? 'active' : '')}
                aria-pressed={isFollowing}
                disabled={isFollowing}
                onClick={() => setFocusedStep(null)}
                title={isFollowing ? '正在自动跟踪最新步骤' : '恢复自动跟踪最新步骤'}
              >
                {isFollowing ? '跟踪中' : '点我恢复跟踪'}
              </button>
            </div>
          </div>
          <div className="flow-chain-body" ref={chainBodyRef}>
            {STAGES.map((stage) => (
              <div className="flow-stage" key={stage.title}>
                <h3>{stage.title}</h3>
                {stage.steps.map((stepType) => {
                  const state = stepState(detail, stepType);
                  const last = latestAttempt(detail, stepType);
                  const statusLabel =
                    state === 'SUCCEEDED'
                      ? (attemptDuration(last) ?? STATUS_NAMES[state])
                      : (STATUS_NAMES[state] ?? state);
                  return (
                    <button
                      className={
                        'flow-step ' +
                        (current === stepType ? 'selected ' : '') +
                        state.toLowerCase()
                      }
                      data-step-type={stepType}
                      key={stepType}
                      title={
                        isFollowing && current === stepType
                          ? '点击后停留在此步骤'
                          : '点击查看此步骤输出'
                      }
                      onClick={() => setFocusedStep(stepType)}
                    >
                      <span className="flow-step-mark">
                        {state === 'SUCCEEDED' ? (
                          <Icon name="check" />
                        ) : state === 'FAILED' ? (
                          <Icon name="warning" />
                        ) : (
                          <Icon name="clock" />
                        )}
                      </span>
                      <span className="flow-step-main">
                        <strong>{STEP_NAMES[stepType]}</strong>
                        <small>{stepSummary(detail, stepType)}</small>
                      </span>
                      <span className="flow-step-status">
                        {statusLabel}
                        {last && last.attemptNo > 1 ? ' · ' + last.attemptNo + ' 次' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
        <section className="card flow-inspector">
          <div className="card-heading">
            <div>
              <span className="flow-eyebrow">阶段输出</span>
              <h2>{STEP_NAMES[current] ?? current}</h2>
            </div>
          </div>
          <div className="flow-inspector-body">
            <div className="flow-inspector-meta">
              <span
                className={
                  'flow-pill ' +
                  (stepState(detail, current) === 'FAILED'
                    ? 'danger'
                    : stepState(detail, current) === 'SUCCEEDED'
                      ? 'success'
                      : '')
                }
              >
                {STATUS_NAMES[stepState(detail, current)] ?? stepState(detail, current)}
              </span>
              {attempt ? (
                <span>
                  第 {attempt.attemptNo} 次尝试 · {time(attempt.startedAt)}
                  {attempt.finishedAt ? ' → ' + time(attempt.finishedAt) : ''}
                </span>
              ) : null}
            </div>
            {attempt?.errorMessage ? (
              <div className="flow-inline-error">
                <strong>{attempt.errorCategory ?? '执行错误'}</strong>：
                {attempt.errorMessage}
              </div>
            ) : null}
            <StepOutput
              detail={detail}
              stepType={current}
              selected={selected}
              onSelect={setSelected}
              onChoose={() => {
                if (selected)
                  act('/direction-selection', { directionId: selected }, '选择方向失败');
              }}
            />
          </div>
        </section>
      </div>
      <section className="card flow-events">
        <div className="card-heading">
          <h2>运行记录</h2>
          <span>{detail.events.length} 条已保存事件</span>
        </div>
        <div className="flow-event-list">
          {[...detail.events].reverse().map((event) => (
            <div className="flow-event" key={event.id}>
              <span className="flow-event-dot" />
              <div>
                <strong>{eventTitle(event)}</strong>
                <small>
                  {time(event.occurredAt)} · #{event.id}
                </small>
                <details>
                  <summary>查看事件数据</summary>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </details>
              </div>
            </div>
          ))}
        </div>
      </section>
      <ToastNotice message={error} />
    </div>
  );
}
