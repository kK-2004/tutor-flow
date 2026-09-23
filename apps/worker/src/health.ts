/**
 * Worker 健康检查 HTTP 服务。
 *
 * - /healthz：进程存活探针（liveness）
 * - /readyz：依赖就绪探针（readiness），逐项检查 Redis 等依赖
 *
 * Publisher 故障不应拖垮 Worker 进程本身，因此健康检查只反映
 * Worker 自身与核心依赖状态，不探测外部平台可达性。
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MetricsSnapshot } from '@tutor-flow/observability';

/** 就绪检查项：名称与异步探测函数 */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface HealthServerOptions {
  /** 监听端口；0 表示由操作系统分配空闲端口 */
  port: number;
  host?: string;
  /** 就绪检查项；任一失败则 /readyz 返回 503 */
  readinessChecks?: ReadinessCheck[];
  /** 可选的 Prometheus 文本指标快照 */
  metrics?: () => MetricsSnapshot;
}

export class HealthServer {
  private readonly server: Server;
  private readonly readinessChecks: ReadinessCheck[];
  private readonly metrics?: () => MetricsSnapshot;

  constructor(options: HealthServerOptions) {
    this.readinessChecks = options.readinessChecks ?? [];
    this.metrics = options.metrics;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    const host = options.host ?? '127.0.0.1';
    this.server.listen(options.port, host);
  }

  /** 实际监听端口（支持操作系统随机分配） */
  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('健康检查服务尚未完成端口监听');
    }
    return (address as AddressInfo).port;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    if (url === '/healthz') {
      this.respond(res, 200, { status: 'ok' });
      return;
    }
    if (url === '/readyz') {
      await this.handleReadiness(res);
      return;
    }
    if (url === '/metrics') {
      this.respondMetrics(res);
      return;
    }
    this.respond(res, 404, { error: 'not found' });
  }

  private async handleReadiness(res: ServerResponse): Promise<void> {
    const failed: string[] = [];
    for (const item of this.readinessChecks) {
      try {
        await item.check();
      } catch {
        // 不泄露依赖错误细节，只标记失败项
        failed.push(item.name);
      }
    }
    if (failed.length > 0) {
      this.respond(res, 503, { status: 'degraded', failed });
      return;
    }
    this.respond(res, 200, { status: 'ready' });
  }

  private respond(res: ServerResponse, statusCode: number, body: object): void {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }

  private respondMetrics(res: ServerResponse): void {
    const snapshot = this.metrics?.() ?? { counters: {}, gauges: {}, histograms: {} };
    const lines = [
      ...Object.entries(snapshot.counters).map(([name, value]) => `${name} ${value}`),
      ...Object.entries(snapshot.gauges).map(([name, value]) => `${name} ${value}`),
      ...Object.entries(snapshot.histograms).flatMap(([name, value]) => [
        `${name}_count ${value.count}`,
        `${name}_sum ${value.sum}`,
        `${name}_max ${value.max}`,
      ]),
    ];
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.end(`${lines.join('\n')}\n`);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}
