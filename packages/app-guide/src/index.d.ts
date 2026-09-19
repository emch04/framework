export type TranslationResolver = (key: string) => string;

export interface GuideItemConfig {
  labelKey: string;
  route?: string;
  visibleDirectly?: boolean;
}

export interface GuideSectionConfig {
  titleKey: string;
  items?: GuideItemConfig[];
}

export interface GuideRoleConfig {
  tabs?: string[];
  sections?: GuideSectionConfig[];
  settingKeys?: string[];
}

export interface GuideTaskConfig {
  id: string;
  keywordKeys?: string[];
  roles?: string[];
  stepKeys?: string[];
  route?: string;
}

export interface GuideActionConfig {
  labelKey: string;
  effectKey: string;
}

export interface GuidePageConfig {
  nameKey?: string;
  purposeKey: string;
  contentKeys?: string[];
  actions?: GuideActionConfig[];
  sourceFiles?: string[];
}

export interface AppGuideConfig {
  applicationKey: string;
  roles: Record<string, GuideRoleConfig>;
  tasks?: GuideTaskConfig[];
  pages?: Record<string, GuidePageConfig>;
}

export interface GuideItem {
  name: string;
  visibleDirectly: boolean;
  route?: string;
}

export interface GuideRole {
  tabs: string[];
  sections: Array<{ title: string; items: GuideItem[] }>;
  settings: string[];
}

export interface GuideTask {
  id: string;
  keywords: string[];
  roles: string[];
  steps: string[];
  route?: string;
}

export interface GuidePage {
  name: string;
  purpose: string;
  content: string[];
  actions: Array<{ label: string; effect: string }>;
}

export interface AppGuide {
  application: string;
  roles: Record<string, GuideRole>;
  tasks: GuideTask[];
  pages: Record<string, GuidePage>;
}

export function createTranslationResolver(
  dictionary: Record<string, unknown>,
  options?: { missing?: (key: string) => string }
): TranslationResolver;
export function buildGuide(config: AppGuideConfig, translate: TranslationResolver): AppGuide;
export function generateGuideJson(
  config: AppGuideConfig,
  translate: TranslationResolver,
  options?: { space?: number }
): string;
export function generateGuides(
  config: AppGuideConfig,
  languages: Record<string, TranslationResolver>,
  options?: { space?: number }
): Record<string, string>;

export interface RoleFilteredGuide {
  application: string;
  role: string;
  navigation: GuideRole;
  tasks: GuideTask[];
  pages: Record<string, GuidePage>;
}

export function filterGuideByRole(guide: AppGuide, role: string): RoleFilteredGuide | null;
export function normalize(value: unknown): string;

export interface GuideLookup {
  role: string;
  tasks: GuideTask[];
  pages: Array<GuidePage & { route: string; displayName: string }>;
  paths: Array<{
    section?: string;
    item?: string;
    viaOverflow?: boolean;
    route?: string;
    setting?: string;
    tab?: string;
  }>;
  fallback: GuideRole | null;
}

export function lookupGuide(
  guide: AppGuide,
  options: { role: string; question?: string; maxTasks?: number; maxPages?: number; maxPaths?: number }
): GuideLookup | null;

export type UsagePattern = string | RegExp;
export function createUsageQuestionDetector(options: {
  patterns: Record<string, UsagePattern[]>;
  fallbackLanguage?: string;
}): (question: unknown, language: string) => boolean;

export interface CoverageResult { ok: boolean; missing: string[] }
export function collectTranslationKeys(config: AppGuideConfig): string[];
export function checkI18nKeys(config: AppGuideConfig, hasTranslation: (key: string) => boolean): CoverageResult;
export function checkRoutesExist(config: AppGuideConfig, routeExists: (route: string) => boolean): CoverageResult;
export function checkPageCoverage(config: AppGuideConfig): {
  ok: boolean;
  missing: string[];
  orphaned: string[];
};
export function checkActionKeysInSources(config: AppGuideConfig, adapters: {
  fileExists(file: string): boolean;
  readSource(file: string): string;
}): {
  ok: boolean;
  missingFiles: Array<{ route: string; file: string }>;
  missingActionKeys: Array<{ route: string; key: string }>;
};
