/**
 * 平台范围定义。
 *
 * 首期只支持小红书；扩展新平台时在此登记，
 * 不允许在业务代码中出现游离的平台字符串。
 */

/** 支持的平台集中定义，创建工作流与提示词设置共用这份清单。 */
export const PLATFORM_DEFINITIONS = {
  xiaohongshu: { name: '小红书', contentType: '图文内容' },
} as const;

export type Platform = keyof typeof PLATFORM_DEFINITIONS;

/** 支持的发布平台标识 */
export const PLATFORMS = Object.keys(PLATFORM_DEFINITIONS) as [Platform, ...Platform[]];

/** 含平台名称与内容形态的选项清单 */
export const PLATFORM_OPTIONS = PLATFORMS.map((id) => ({
  id,
  ...PLATFORM_DEFINITIONS[id],
}));

/** 唯一支持的平台常量，用于校验与默认值 */
export const XIAOHONGSHU: Platform = 'xiaohongshu';

/** 判断给定字符串是否为受支持的平台 */
export function isPlatform(value: string): value is Platform {
  return Object.hasOwn(PLATFORM_DEFINITIONS, value);
}
