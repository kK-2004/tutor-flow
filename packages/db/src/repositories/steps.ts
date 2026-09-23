/**
 * 步骤尝试查询仓储。
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import type { DbExecutor } from '../lib/tx.js';
import { stepRuns } from '../schema/index.js';

type StepRunRow = typeof stepRuns.$inferSelect;

/** 读取运行内全部步骤尝试（按步骤类型与尝试序号排序） */
export async function listStepAttempts(
  db: DbExecutor,
  runId: string,
): Promise<StepRunRow[]> {
  return db
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.runId, runId))
    .orderBy(asc(stepRuns.stepType), asc(stepRuns.attemptNo));
}

/** 读取指定步骤的最新尝试 */
export async function getLatestStepAttempt(
  db: DbExecutor,
  runId: string,
  stepType: StepRunRow['stepType'],
): Promise<StepRunRow | null> {
  const rows = await db
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.stepType, stepType)))
    .orderBy(desc(stepRuns.attemptNo))
    .limit(1);
  return rows[0] ?? null;
}
