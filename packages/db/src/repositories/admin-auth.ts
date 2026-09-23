/**
 * 管理后台认证仓储：用户、密码哈希与会话令牌摘要。
 *
 * 原始密码和会话令牌不得写入数据库或日志。
 */
import {
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';

import { and, asc, eq, gt } from 'drizzle-orm';

import type { DbExecutor } from '../lib/tx.js';
import { adminSessions, adminUsers } from '../schema/index.js';

export type AdminRole = 'SUPER_ADMIN' | 'ADMIN';
type AdminUserRow = typeof adminUsers.$inferSelect;

const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELISM,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

/** 使用 scrypt 派生密码哈希。 */
export async function hashAdminPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePasswordKey(password, salt);
  return [
    'scrypt',
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELISM),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/** 恒定时间校验管理后台密码。 */
export async function verifyAdminPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, cost, blockSize, parallelism, saltValue, keyValue] =
    encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelism !== String(SCRYPT_PARALLELISM) ||
    !saltValue ||
    !keyValue
  ) {
    return false;
  }
  const expected = Buffer.from(keyValue, 'base64');
  const actual = await derivePasswordKey(password, Buffer.from(saltValue, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 用户名统一为小写，避免同名账号因大小写重复。 */
export function normalizeAdminUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** 创建后台用户。 */
export async function createAdminUser(
  db: DbExecutor,
  input: {
    username: string;
    passwordHash: string;
    role: AdminRole;
    createdBy?: string;
  },
): Promise<AdminUserRow> {
  const [created] = await db
    .insert(adminUsers)
    .values({
      username: normalizeAdminUsername(input.username),
      passwordHash: input.passwordHash,
      role: input.role,
      createdBy: input.createdBy,
    })
    .returning();
  if (created === undefined) throw new Error('后台用户创建失败');
  return created;
}

export async function findAdminUserByUsername(
  db: DbExecutor,
  username: string,
): Promise<AdminUserRow | null> {
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.username, normalizeAdminUsername(username)))
    .limit(1);
  return user ?? null;
}

export async function findAdminUser(
  db: DbExecutor,
  userId: string,
): Promise<AdminUserRow | null> {
  const [user] = await db
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);
  return user ?? null;
}

/** 返回不含密码哈希的后台用户列表。 */
export async function listAdminUsers(db: DbExecutor) {
  return db
    .select({
      id: adminUsers.id,
      username: adminUsers.username,
      role: adminUsers.role,
      createdAt: adminUsers.createdAt,
      updatedAt: adminUsers.updatedAt,
    })
    .from(adminUsers)
    .orderBy(asc(adminUsers.createdAt));
}

export async function updateAdminPassword(
  db: DbExecutor,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(adminUsers)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(adminUsers.id, userId));
}

export async function createAdminSession(
  db: DbExecutor,
  input: { tokenHash: string; userId: string; expiresAt: Date },
): Promise<void> {
  await db.insert(adminSessions).values(input);
}

export async function findAdminSession(db: DbExecutor, tokenHash: string) {
  const [session] = await db
    .select({
      tokenHash: adminSessions.tokenHash,
      userId: adminUsers.id,
      username: adminUsers.username,
      role: adminUsers.role,
      expiresAt: adminSessions.expiresAt,
    })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminSessions.userId, adminUsers.id))
    .where(
      and(
        eq(adminSessions.tokenHash, tokenHash),
        gt(adminSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

export async function deleteAdminSession(
  db: DbExecutor,
  tokenHash: string,
): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, tokenHash));
}

export async function deleteAdminSessionsForUser(
  db: DbExecutor,
  userId: string,
): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.userId, userId));
}

/** 生成适合一次性展示给管理员的随机初始密码。 */
export function generateAdminPassword(): string {
  return `${randomUUID().replaceAll('-', '').slice(0, 16)}!Aa9`;
}
