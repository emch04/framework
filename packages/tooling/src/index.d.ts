export interface AstratraConfig {
  audit: {
    secrets: {
      dirs: string[];
    };
    routes: RouteAuditOptions & {
      dirs: string[];
    };
    i18n: {
      localesDir: string;
      sourceDirs: string[];
      referenceLocale: string | null;
    };
  };
  test: {
    workspaces: null | Array<string | { path: string; name?: string }>;
  };
  deploy: {
    steps: DeployStepInput[];
    modes: Record<string, { steps?: DeployStepInput[]; skip?: string[] }>;
  };
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: AstratraConfig;
export function loadConfig(rootDir?: string): AstratraConfig;
export function mergeConfig<TBase extends Record<string, unknown>, TOverride>(base: TBase, override: TOverride): TBase & TOverride;

export interface CommandOptions {
  dir?: string;
  output?: Pick<Console, 'log'>;
  [key: string]: unknown;
}

export interface CommandResult {
  exitCode: number;
}

export interface SecretFinding {
  file: string;
  line: number;
  code: string;
}

export interface AuditSecretsResult extends CommandResult {
  findings: SecretFinding[];
}

export function findSecretLeaks(filePath: string): Array<Omit<SecretFinding, 'file'>>;
export function auditSecrets(rootDir: string, config: AstratraConfig, options?: CommandOptions): AuditSecretsResult;
export function printAuditSecrets(result: AuditSecretsResult, output?: Pick<Console, 'log'>): void;
export function runAuditSecrets(rootDir: string, config: AstratraConfig, options?: CommandOptions): AuditSecretsResult;

export interface RouteAuditOptions {
  authMiddlewarePatterns: string[];
  publicMarkers: string[];
}

export interface RouteFinding {
  file: string;
  line: number;
  method: string;
  route: string;
  code: string;
}

export interface AuditRoutesResult extends CommandResult {
  fileCount: number;
  findings: RouteFinding[];
}

export function auditRouteFile(filePath: string, options: RouteAuditOptions): Array<Omit<RouteFinding, 'file'>>;
export function auditRoutes(rootDir: string, config: AstratraConfig, options?: CommandOptions): AuditRoutesResult;
export function findRouteFiles(dir: string): string[];
export function runAuditRoutes(rootDir: string, config: AstratraConfig, options?: CommandOptions): AuditRoutesResult;

export type TranslationCatalogs = Map<string, Set<string>>;

export interface I18nFinding {
  type: 'missing' | 'extra' | 'unused-key';
  catalog?: string;
  file?: string;
  key: string;
  line?: number;
  referenceLocale?: string | null;
}

export interface AuditI18nResult extends CommandResult {
  catalogs: string[];
  findings: I18nFinding[];
  referenceLocale: string | null;
}

export function flattenKeys(value: Record<string, unknown>, prefix?: string): string[];
export function readCatalogs(localesDir: string): TranslationCatalogs;
export function auditI18n(rootDir: string, config: AstratraConfig, options?: CommandOptions): AuditI18nResult;
export function runAuditI18n(rootDir: string, config: AstratraConfig, options?: CommandOptions): AuditI18nResult;

export interface WorkspaceEntry {
  name: string;
  path: string;
  color: string;
}

export interface TestCommandResult extends CommandResult {
  results: Array<{ name: string; path: string; code: number | null }>;
  workspaces: WorkspaceEntry[];
}

export interface RunShellOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onLine?: (line: string) => void;
}

export type RunCommand = (command: string, options?: RunShellOptions) => Promise<{ code: number | null }>;

export interface RunTestsOptions extends CommandOptions {
  runCommand?: RunCommand;
}

export function expandWorkspacePattern(rootDir: string, pattern: string): string[];
export function detectWorkspaces(rootDir: string, config: AstratraConfig): WorkspaceEntry[];
export function runTests(rootDir: string, config: AstratraConfig, options?: RunTestsOptions): Promise<TestCommandResult>;

export type DeployStepInput = string | { name?: string; command?: string };

export interface DeployStep {
  name: string;
  command?: string;
}

export interface DeployResult extends CommandResult {
  results: Array<{ name: string; command?: string; code: number | null }>;
}

export interface RunDeployOptions extends CommandOptions {
  mode?: string;
  runCommand?: RunCommand;
}

export function resolveDeploySteps(config: AstratraConfig, modeName?: string): DeployStepInput[];
export function runDeploy(rootDir: string, config: AstratraConfig, options?: RunDeployOptions): Promise<DeployResult>;

export type CommandRunner = (rootDir: string, config: AstratraConfig, options?: CommandOptions) => CommandResult | Promise<CommandResult>;
export const COMMANDS: Record<string, CommandRunner>;

export interface RunCliOptions {
  rootDir?: string;
  config?: AstratraConfig;
}

export function runCli(argv?: string[], options?: RunCliOptions): Promise<CommandResult>;
