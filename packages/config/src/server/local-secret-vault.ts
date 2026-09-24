import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function loadOrCreateKey(databasePath: string): Promise<Buffer> {
  const resolvedPath = databasePath.startsWith('file:')
    ? fileURLToPath(databasePath)
    : databasePath;
  const keyPath = `${resolvedPath}.llm-secrets-key`;
  await mkdir(path.dirname(keyPath), { recursive: true });
  try {
    const key = await readFile(keyPath);
    if (key.length !== 32) throw new Error('模型密钥加密文件格式无效');
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const key = randomBytes(32);
  try {
    await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingKey = await readFile(keyPath);
    if (existingKey.length !== 32) throw new Error('模型密钥加密文件格式无效');
    return existingKey;
  }
}

export async function encryptLocalSecret(
  value: string,
  databasePath: string,
): Promise<string> {
  const key = await loadOrCreateKey(databasePath);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export async function decryptLocalSecret(
  encryptedValue: string,
  databasePath: string,
): Promise<string> {
  const [version, nonceValue, authTagValue, ciphertextValue] = encryptedValue.split('.');
  if (
    version !== 'v1' ||
    nonceValue === undefined ||
    authTagValue === undefined ||
    ciphertextValue === undefined
  ) {
    throw new Error('模型密钥密文格式无效');
  }
  const key = await loadOrCreateKey(databasePath);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(nonceValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(authTagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
