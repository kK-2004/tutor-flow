/**
 * 平台范围定义。
 *
 * 首期只支持小红书；扩展新平台时在此登记，
 * 不允许在业务代码中出现游离的平台字符串。
 */

/** 支持的发布平台 */
export const PLATFORMS = ['xiaohongshu'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** 唯一支持的平台常量，用于校验与默认值 */
export const XIAOHONGSHU: Platform = 'xiaohongshu';

/** 判断给定字符串是否为受支持的平台 */
export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}
