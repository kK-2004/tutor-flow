/**
 * 研究数据查询仓储：方向选项、事实与来源关联的读取。
 * （写入由研究阶段任务 4.x 的处理器完成。）
 */
import { eq, inArray } from 'drizzle-orm';

import type { DbExecutor } from '../lib/tx.js';
import {
  claimSources,
  claims,
  duplicateClusters,
  directionClaims,
  directionOptions,
  sourceDocuments,
} from '../schema/index.js';

type DirectionOptionRow = typeof directionOptions.$inferSelect;
type ClaimRow = typeof claims.$inferSelect;

/** 读取运行的候选方向（按排名排序） */
export async function listDirectionOptions(
  db: DbExecutor,
  runId: string,
): Promise<DirectionOptionRow[]> {
  return db
    .select()
    .from(directionOptions)
    .where(eq(directionOptions.runId, runId))
    .orderBy(directionOptions.rank);
}

/** 读取运行内全部事实 */
export async function listRunClaims(db: DbExecutor, runId: string): Promise<ClaimRow[]> {
  return db.select().from(claims).where(eq(claims.runId, runId));
}

/** 读取方向依赖的事实 id 列表 */
export async function listDirectionClaimIds(
  db: DbExecutor,
  directionId: string,
): Promise<string[]> {
  const rows = await db
    .select({ claimId: directionClaims.claimId })
    .from(directionClaims)
    .where(eq(directionClaims.directionId, directionId));
  return rows.map((row) => row.claimId);
}

/** 批量读取事实的来源 id 映射 */
export async function listClaimSourceIds(
  db: DbExecutor,
  claimIds: readonly string[],
): Promise<Map<string, string[]>> {
  const mapping = new Map<string, string[]>();
  if (claimIds.length === 0) {
    return mapping;
  }
  const rows = await db
    .select({ claimId: claimSources.claimId, sourceId: claimSources.sourceId })
    .from(claimSources)
    .where(inArray(claimSources.claimId, [...claimIds]));
  for (const row of rows) {
    const existing = mapping.get(row.claimId) ?? [];
    existing.push(row.sourceId);
    mapping.set(row.claimId, existing);
  }
  return mapping;
}

/** 读取运行的来源链路与事实使用位置，供研究资料视图使用。 */
export async function listRunSources(
  db: DbExecutor,
  runId: string,
): Promise<{
  sources: Array<
    typeof sourceDocuments.$inferSelect & {
      cluster: typeof duplicateClusters.$inferSelect | null;
    }
  >;
  claims: Array<typeof claims.$inferSelect & { sourceIds: string[] }>;
}> {
  const sourceRows = await db
    .select({ source: sourceDocuments, cluster: duplicateClusters })
    .from(sourceDocuments)
    .leftJoin(duplicateClusters, eq(sourceDocuments.clusterId, duplicateClusters.id))
    .where(eq(sourceDocuments.runId, runId));
  const claimRows = await db.select().from(claims).where(eq(claims.runId, runId));
  const sourceLinks = await db
    .select({ claimId: claimSources.claimId, sourceId: claimSources.sourceId })
    .from(claimSources)
    .where(
      inArray(
        claimSources.claimId,
        claimRows.map((claim) => claim.id),
      ),
    );
  const links = new Map<string, string[]>();
  for (const link of sourceLinks) {
    links.set(link.claimId, [...(links.get(link.claimId) ?? []), link.sourceId]);
  }
  return {
    sources: sourceRows.map((row) => ({ ...row.source, cluster: row.cluster })),
    claims: claimRows.map((claim) => ({
      ...claim,
      sourceIds: links.get(claim.id) ?? [],
    })),
  };
}
