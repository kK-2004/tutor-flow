import { createHash } from 'node:crypto';

import type { VectorService } from './gateway-types.js';

/** 使用字符二元组进行本地去重，避免额外模型服务与内存常驻开销。 */
export function createLocalVectorService(): VectorService {
  const dimensions = 128;
  return {
    async embed(text) {
      const vector = new Array<number>(dimensions).fill(0);
      const normalized = text.toLowerCase().replace(/\s+/g, '');
      for (let index = 0; index < normalized.length - 1; index += 1) {
        const pair = normalized.slice(index, index + 2);
        const hash = createHash('sha256').update(pair).digest();
        const bucket = (hash[0] ?? 0) % dimensions;
        const sign = (hash[1] ?? 0) % 2 === 0 ? 1 : -1;
        vector[bucket] = (vector[bucket] ?? 0) + sign;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    },
    similarity(a, b) {
      let dot = 0;
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        dot += (a[index] ?? 0) * (b[index] ?? 0);
      }
      return dot;
    },
  };
}
