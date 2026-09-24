export interface ContentPrompt {
  id: string;
  name: string;
  content: string;
  active: boolean;
}

export interface PlatformPrompts {
  id: string;
  name: string;
  prompts: ContentPrompt[];
}

export interface ContentPromptsConfig {
  platforms: PlatformPrompts[];
}
