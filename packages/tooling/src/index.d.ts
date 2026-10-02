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
    deps: {
      severityThreshold: DepsSeverity;
    };
  };
  test: {
    workspaces: null | Array<string | { path: string; name?: string }>;
  };
  deploy: {
    steps: DeployStepInput[];
    modes: Record<string, { steps?: DeployStepInput[]; skip?: string[] }>;
    remote: RemoteDeployConfig | null;
  };
  publish: PublishConfigInput | null;
  dispatch: DispatchConfig | null;
  eval?: EvalConfigInput | null;
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

export type DepsSeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

export interface DepsFinding {
  name: string;
  severity: DepsSeverity;
  range: string;
  fixAvailable: boolean | string;
  isDirect: boolean;
}

export interface AuditDepsResult extends CommandResult {
  parsed: boolean;
  threshold?: DepsSeverity;
  totalVulnerabilities?: Record<string, number> | null;
  findings: DepsFinding[];
  error?: string;
}

export interface AuditDepsOptions extends CommandOptions {
  severity?: DepsSeverity;
}

export function severityRank(severity: string): number;
export function parseNpmAuditJson(rawOutput: string): Record<string, unknown> | null;
export function extractFindings(report: Record<string, unknown>, thresholdRank: number): DepsFinding[];
export function auditDeps(rootDir: string, config: AstratraConfig, options?: AuditDepsOptions): Promise<AuditDepsResult>;
export function runAuditDeps(rootDir: string, config: AstratraConfig, options?: AuditDepsOptions): Promise<AuditDepsResult>;

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

export type DeployStepInput = string | {
  name?: string;
  command?: string;
  /** Relative to the project root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Output goes to this file instead of the console; only its path is shown. */
  logFile?: string;
};

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
  /** Run the full remote flow of `deploy.remote` instead of the steps. */
  remote?: boolean;
}

export function resolveDeploySteps(config: AstratraConfig, modeName?: string): DeployStepInput[];
export function normalizeStep(step: DeployStepInput, index: number): DeployStep & { cwd?: string; env?: Record<string, string>; logFile?: string };
export function runSteps(
  rootDir: string,
  steps: Array<DeployStep & { cwd?: string; env?: Record<string, string>; logFile?: string }>,
  options?: { output?: Pick<Console, 'log'>; runCommand?: RunCommand }
): Promise<Array<{ name: string; command?: string; code: number | null }>>;
export function runDeploy(rootDir: string, config: AstratraConfig, options?: RunDeployOptions): Promise<DeployResult | RemoteDeployResult>;

/* ---- Errors, processes, shell ------------------------------------------- */

export class ToolingError extends Error {
  constructor(code: string, message: string, statusCode?: number, details?: unknown);
  code: string;
  statusCode: number;
  isOperational: boolean;
  details?: unknown;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onLine?: (line: string) => void;
  /** Written to stdin (e.g. the script for `ssh host bash -s`). */
  input?: string;
  /** No line streaming at all. */
  quiet?: boolean;
  /** Capture stdout without streaming it (JSON answers). */
  quietStdout?: boolean;
}

export type RunProcess = (command: string, args?: string[], options?: RunProcessOptions) => Promise<ProcessResult>;
export const runProcess: RunProcess;
export function runShellCommand(command: string, options?: RunShellOptions): Promise<{ code: number | null }>;
export function shellQuote(value: unknown): string;
export function shellJoin(args: unknown[]): string;

export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/* ---- Publishing --------------------------------------------------------- */

export function base64url(value: Buffer | string | Record<string, unknown>): string;
export function signJwt(input: {
  algorithm: 'RS256' | 'ES256';
  header?: Record<string, unknown>;
  payload: Record<string, unknown>;
  privateKey: string | Buffer | import('crypto').KeyObject;
}): string;
export function decodeJwt(token: string): {
  header: Record<string, any>;
  payload: Record<string, any>;
  signature: Buffer;
  signingInput: string;
};

export interface VersionBumpDecision {
  bump: boolean;
  reason: 'no-published-fingerprint' | 'native-changed' | 'native-unchanged';
}

export function decideVersionBump(input: { current: string; published: string | null }): VersionBumpDecision;
export function readPublishedFingerprint(filePath: string): string | null;
export function recordPublishedFingerprint(filePath: string, hash: string): string;
export function computeFingerprint(projectDir: string, options?: {
  compute?: (projectDir: string) => Promise<string | { hash: string }> | string | { hash: string };
  command?: string[] | null;
  runProcess?: RunProcess;
  loadModule?: (projectDir: string) => { createFingerprintAsync(dir: string): Promise<{ hash: string }> } | null;
}): Promise<string>;
export function readRuntimeVersionPolicy(projectDir: string): string;

export type VersionLevel = 'patch' | 'minor' | 'major';
export function bumpVersion(version: string, level?: VersionLevel): string;
export function readPackageVersion(projectDir: string): string;
export function applyVersionBump(projectDir: string, level?: VersionLevel): { from: string; to: string; files: string[] };

export type MobilePlatform = 'ios' | 'android';

export interface EasBuildState {
  status: string;
  url: string | null;
  buildNumber: string | null;
  appVersion: string | null;
}

export function archiveExtension(platform: MobilePlatform): 'ipa' | 'aab';
export function buildEasBuildArgs(input: { platform: MobilePlatform; profile?: string }): string[];
export function buildEasLocalBuildArgs(input: { platform: MobilePlatform; profile?: string; output: string }): string[];
export function buildEasViewArgs(buildId: string): string[];
export function buildEasUpdateArgs(input: { channel?: string; environment?: string; message: string; inputDir: string }): string[];
export function parseBuildStart(stdout: string): string;
export function parseBuildView(stdout: string): EasBuildState;
export function waitForBuild(options: {
  buildId: string;
  view: (buildId: string) => Promise<EasBuildState>;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  maxViewFailures?: number;
  onStatus?: (state: EasBuildState) => void;
  now?: () => number;
}): Promise<EasBuildState>;
export function artifactFileName(input: { appName: string; platform: MobilePlatform; version: string; buildNumber: string | null; template?: string | null }): string;
export function downloadArtifact(input: { url: string; filePath: string; fetch?: FetchLike }): Promise<{ filePath: string; bytes: number }>;
export function formatBytes(bytes: number): string;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export const PLAY_SCOPE: string;
export function loadServiceAccount(options?: { path?: string | null; jsonEnv?: string | null; env?: Record<string, string | undefined> }): ServiceAccount;
export type PlayReleaseStatus = 'completed' | 'draft' | 'inProgress' | 'halted';
export interface GooglePlayClient {
  getAccessToken(): Promise<string>;
  uploadBundle(options: {
    filePath?: string;
    body?: Buffer;
    track?: string;
    releaseStatus?: PlayReleaseStatus;
    userFraction?: number;
    releaseName?: string;
    releaseNotes?: Array<{ language: string; text: string }>;
    changesNotSentForReview?: boolean;
  }): Promise<{ versionCode: number | string; editId: string; track: string; packageName: string }>;
}
export function createGooglePlayClient(options: {
  packageName: string;
  serviceAccount: ServiceAccount;
  fetch?: FetchLike;
  now?: () => number;
  apiBase?: string;
  uploadBase?: string;
}): GooglePlayClient;

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPath: string;
}

export interface AscCredentialOptions {
  envFile?: string | null;
  keyIdEnv?: string;
  issuerIdEnv?: string;
  privateKeyPath?: string | null;
  keysDirs?: string[] | null;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  cwd?: string;
  allowMissingEnvFile?: boolean;
}

export const ASC_AUDIENCE: string;
export const MAX_TOKEN_TTL_SECONDS: number;
export function parseEnvFile(text: string): Record<string, string>;
export function expandHome(value: string, homeDir?: string): string;
export function defaultKeysDirs(homeDir?: string, cwd?: string): string[];
export function loadAscCredentials(options?: AscCredentialOptions): AscCredentials;
export function hasAscCredentials(options?: AscCredentialOptions): boolean;
export function createAscToken(input: { keyId: string; issuerId: string; privateKey: string | Buffer; now?: number; ttlSeconds?: number }): string;
export function checkAscKey(options: {
  credentials: Partial<AscCredentials> & { keyId: string; issuerId: string };
  privateKey?: string;
  fetch?: FetchLike;
  now?: () => number;
  bundleId?: string | null;
  apiBase?: string;
}): Promise<{ ok: true; status: number; appCount: number; appId: string | null }>;
export function buildAltoolCommand(input: {
  filePath: string;
  keyId: string;
  issuerId: string;
  privateKeyPath?: string;
  platform?: 'ios' | 'macos' | 'appletvos' | 'visionos';
  outputFormat?: string;
}): { command: 'xcrun'; args: string[]; env: Record<string, string> };
export function uploadToAppStore(options: {
  filePath: string;
  credentials: AscCredentials | { keyId: string; issuerId: string; privateKeyPath?: string };
  runProcess?: RunProcess;
  onLine?: (line: string) => void;
  env?: Record<string, string | undefined>;
  cwd?: string;
  platform?: 'ios' | 'macos' | 'appletvos' | 'visionos';
}): Promise<{ ok: true }>;

export function createDesktopNotifier(options?: {
  enabled?: boolean;
  platform?: string;
  runProcess?: RunProcess;
  titlePrefix?: string;
}): (title: string, message: string) => Promise<void>;

export interface PublishConfigInput {
  appName?: string | null;
  projectDir?: string;
  fingerprintFile?: string;
  fingerprint?: { command?: string[] | null };
  versionBump?: VersionLevel | false;
  eas?: { command?: string[]; mode?: 'cloud' | 'local'; localWorkDir?: string | null; profile?: string; channel?: string; pollIntervalMs?: number; timeoutMs?: number; buildUrlTemplate?: string | null };
  downloadsDir?: string;
  fileNameTemplate?: string | null;
  android?: {
    upload?: 'api' | 'manual';
    packageName?: string | null;
    track?: string;
    releaseStatus?: PlayReleaseStatus;
    serviceAccountPath?: string | null;
    serviceAccountJsonEnv?: string | null;
    consoleUrl?: string;
  };
  ios?: {
    ascEnvFile?: string | null;
    keyIdEnv?: string;
    issuerIdEnv?: string;
    privateKeyPath?: string | null;
    keysDirs?: string[] | null;
    bundleId?: string | null;
    checkKey?: boolean;
    fallback?: 'transporter' | 'none';
  };
  notify?: boolean;
}

export type PublishTarget = 'ios' | 'android' | 'all' | 'update';

export interface PublishOptions extends CommandOptions {
  target?: PublishTarget;
  message?: string;
  runProcess?: RunProcess;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  notify?: (title: string, message: string) => Promise<void>;
  open?: (args: string[]) => Promise<unknown>;
  computeFingerprint?: (projectDir: string) => Promise<string | { hash: string }>;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  osPlatform?: string;
}

export interface PublishResult extends CommandResult {
  target?: PublishTarget;
  version?: string;
  message?: string;
  bumped?: { from: string; to: string; files: string[] } | null;
  results: Array<{ platform: MobilePlatform; ok: boolean; code?: string; message?: string; delivered?: boolean; handoff?: string; filePath?: string; buildNumber?: string | null; versionCode?: number | string }>;
  error?: { code: string; message: string };
}

export const PUBLISH_DEFAULTS: Required<PublishConfigInput>;
export const PUBLISH_TARGETS: PublishTarget[];
export function resolvePublishConfig(rootDir: string, config?: Partial<AstratraConfig>, homeDir?: string): Required<PublishConfigInput> & { projectDir: string };
export function runPublish(rootDir: string, config: Partial<AstratraConfig>, options?: PublishOptions): Promise<PublishResult>;
export function runPublishFingerprint(rootDir: string, config: Partial<AstratraConfig>, options?: PublishOptions & { record?: boolean }): Promise<CommandResult & { current?: string; published?: string | null; decision?: VersionBumpDecision; recorded?: boolean; error?: { code: string; message: string } }>;
export function runPublishUpload(rootDir: string, config: Partial<AstratraConfig>, options?: PublishOptions & { platform?: MobilePlatform; file?: string }): Promise<CommandResult & { delivered?: boolean; error?: { code: string; message: string } }>;
export function runPublishCheckIos(rootDir: string, config: Partial<AstratraConfig>, options?: PublishOptions): Promise<CommandResult & { appCount?: number; error?: { code: string; message: string } }>;

/* ---- Remote deploy ------------------------------------------------------ */

export interface RemoteHealthConfig {
  internal?: string[];
  public?: string[];
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
  publicAttempts?: number;
  publicIntervalMs?: number;
  publicTimeoutMs?: number;
}

export interface RemoteDeployConfig {
  host: string;
  name?: string | null;
  sshOptions?: string[];
  appUser?: string | null;
  appDir: string;
  nodeDir?: string | null;
  remote?: string;
  branch?: string;
  requireBranch?: boolean;
  refuseDirty?: boolean;
  push?: boolean;
  secretPatterns?: Array<string | RegExp> | null;
  allowTrackedFiles?: string[];
  lockFile?: string | null;
  preSteps?: DeployStepInput[];
  depsPattern?: string;
  installCommand?: string | null;
  reloadCommand?: string | null;
  pm2?: { ecosystem: string; only?: string | string[] } | null;
  rollback?: boolean;
  health?: RemoteHealthConfig;
  status?: { pm2?: boolean; pm2Apps?: string[]; backupLog?: string | null; backupPattern?: string | null; backupMaxAgeDays?: number };
  notify?: boolean;
}

export interface RemoteDeployResult extends CommandResult {
  target?: string | null;
  previous?: string | null;
  depsChanged?: boolean;
  stage?: string;
  stages: string[];
  error?: { code: string; message: string };
}

export interface RemoteDeployOptions extends CommandOptions {
  runProcess?: RunProcess;
  runCommand?: RunCommand;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  notify?: (title: string, message: string) => Promise<void>;
  lock?: { pid?: number; isAlive?: (pid: number) => boolean };
  osPlatform?: string;
}

export const REMOTE_DEFAULTS: RemoteDeployConfig;
export function resolveRemoteConfig(rootDir: string, config: Partial<AstratraConfig>): Required<RemoteDeployConfig>;
export function runRemoteDeploy(rootDir: string, config: Partial<AstratraConfig>, options?: RemoteDeployOptions): Promise<RemoteDeployResult>;
export function runHealth(rootDir: string, config: Partial<AstratraConfig>, options?: RemoteDeployOptions & { now?: () => number }): Promise<CommandResult & { problems: string[]; sentence?: string; checks?: unknown }>;

export function acquireLock(lockDir: string, options?: { pid?: number; isAlive?: (pid: number) => boolean; now?: () => number }): { path: string; release(): void };
export const DEFAULT_SECRET_PATTERNS: string[];
export function findTrackedSecrets(files: string[], options?: { patterns?: Array<string | RegExp>; allow?: string[] }): string[];
export function runGit(run: RunProcess, cwd: string, args: string[]): Promise<string>;
export function assertCleanTree(options: { cwd: string; runProcess?: RunProcess }): Promise<void>;
export function assertBranch(options: { cwd: string; branch: string; runProcess?: RunProcess }): Promise<void>;
export function assertNoTrackedSecrets(options: { cwd: string; patterns?: Array<string | RegExp>; allow?: string[]; runProcess?: RunProcess }): Promise<void>;
export function checkHealth(options: {
  url: string;
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
  expectStatus?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; url: string; attempts: number; status: number; error?: string | null }>;
export function analysePm2(jlist: string | null | undefined, expected?: string[]): { readable: boolean; offline: string[]; missing: string[]; count?: number };
export function backupAgeDays(line: string | null | undefined, now?: number): number | null;
export const MARKER: string;
export const REMOTE_DEPLOY_SCRIPT: string;
export const REMOTE_STATUS_SCRIPT: string;
export function buildRemoteDeployArgs(remote: RemoteDeployConfig, target: string): string[];
export function buildSshInvocation(input: { host: string; sshOptions?: string[]; args?: string[] }): { command: 'ssh'; args: string[] };
export function parseMarkers(stdout: string): Record<string, string> & { urls?: Array<{ status: number; url: string }> };
export function pm2ReloadCommand(input: { ecosystem: string; only?: string | string[] }): string;

/* ---- Remote dispatcher -------------------------------------------------- */

export interface DispatchAction {
  /** ^[a-z][a-z0-9-]{0,63}$ */
  name: string;
  cwd: string;
  /** Argument list, quoted into the script; never re-parsed. */
  command: string[];
  /** Default true: answer at once, run with a lock and a log. */
  background?: boolean;
  tailLines?: number;
  description?: string;
}

export interface DispatchConfig {
  actions: DispatchAction[];
  statusAction?: string;
  logDir?: string;
  path?: string[];
  notify?: 'macos' | 'none';
  statusLines?: number;
  messages?: Partial<typeof DEFAULT_MESSAGES>;
  output?: string;
  installPath?: string;
  publicKeyFile?: string;
  from?: string;
}

export const ACTION_NAME: RegExp;
export const KEY_RESTRICTIONS: string[];
export const DEFAULT_MESSAGES: Record<'refused' | 'unknown' | 'launched' | 'alreadyRunning' | 'lockBusy' | 'noneYet' | 'running' | 'finished' | 'done' | 'failed' | 'missingDir', string>;
export function resolveDispatchAction(raw: unknown, actionNames: string[]): { ok: true; action: string } | { ok: false; reason: 'invalid' | 'unknown' };
export function generateDispatcherScript(config: DispatchConfig): string;
export function authorizedKeysLine(input: { scriptPath: string; publicKey: string; from?: string }): string;
export function runDispatchGenerate(rootDir: string, config: Partial<AstratraConfig>, options?: CommandOptions & { out?: string; key?: string }): Promise<CommandResult & { script?: string; written?: string | null; authorizedKeysLine?: string | null; error?: { code: string; message: string } }>;

export type CommandRunner = (rootDir: string, config: AstratraConfig, options?: CommandOptions) => CommandResult | Promise<CommandResult>;
export const COMMANDS: Record<string, CommandRunner>;

export interface RunCliOptions {
  rootDir?: string;
  config?: AstratraConfig;
}

export function runCli(argv?: string[], options?: RunCliOptions): Promise<CommandResult>;

/* ---- Test guards -------------------------------------------------------- */

export type RoleSpelling = string | RegExp;

export interface RoleWriteException {
  /** Substring (or RegExp) of the write declaration, e.g. the quoted route path. */
  match: string | RegExp;
  /** Why this write is allowed. Required: an unexplained exception is refused. */
  reason: string;
  /** Limit the exception to files whose relative path contains this string. */
  file?: string;
}

export interface RoleWriteSourceOptions {
  role: RoleSpelling | RoleSpelling[];
  writeCalls?: RegExp[];
  authorListNames?: RegExp | false;
  exclusions?: RegExp[];
}

export interface RoleWriteOptions extends RoleWriteSourceOptions {
  dirs: string[];
  rootDir?: string;
  exceptions?: RoleWriteException[];
  include?: (name: string, fullPath: string) => boolean;
  skippedDirs?: string[];
}

export interface RoleWriteSourceFinding {
  kind: 'route' | 'list';
  line: number;
  /** Identifiers the role came through, e.g. ['WRITERS', 'STAFF']. */
  via: string[];
  code: string;
  method?: string;
  route?: string | null;
  name?: string;
}

export interface RoleWriteFinding extends RoleWriteSourceFinding {
  file: string;
}

export interface RoleWriteResult {
  fileCount: number;
  findings: RoleWriteFinding[];
  exempted: Array<RoleWriteFinding & { reason: string }>;
  unusedExceptions: RoleWriteException[];
}

export const DEFAULT_WRITE_CALLS: RegExp[];
export function auditRoleWriteSource(source: string, options: RoleWriteSourceOptions): RoleWriteSourceFinding[];
export function auditRoleWrites(options: RoleWriteOptions): RoleWriteResult;
export function assertRoleReadOnly(options: RoleWriteOptions): RoleWriteResult;
export function formatRoleWriteFindings(result: RoleWriteResult): string;

export interface FactComparisonOptions {
  tolerance?: number;
  arrayOrder?: 'ignore' | 'strict';
  requireEveryFact?: boolean;
}

export interface FactReport {
  ok: boolean;
  mismatches: Array<{ key: string; fact: unknown; claim: unknown }>;
  unextracted: Array<{ key: string; side: 'fact' | 'claim' | 'both'; fact: unknown; claim: unknown }>;
  unbacked: Array<{ key: string; claim: unknown }>;
  unstated: Array<{ key: string; fact: unknown }>;
}

export interface FactInput {
  facts: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export function compareFacts(input: FactInput, options?: FactComparisonOptions): FactReport;
export function assertFactsAligned(input: FactInput, options?: FactComparisonOptions): FactReport;
export function formatFactReport(report: FactReport): string;
export function pickPaths(document: unknown, paths: Record<string, string>): Record<string, unknown>;
export function extractMatches(
  text: string,
  patterns: Record<string, RegExp>,
  options?: { parse?: (raw: string, key: string) => unknown }
): Record<string, unknown>;

export type TermInput = string | RegExp | { pattern: string | RegExp; reason?: string };
export type TextsInput = string | string[] | Record<string, string> | Array<{ name: string; text: string }>;

export interface TermOptions {
  allow?: TermInput[];
  required?: TermInput[];
}

export interface TermFinding {
  source: string;
  term: string;
  reason?: string;
  match: string;
  line: number;
  excerpt: string;
}

export interface TermReport {
  ok: boolean;
  findings: TermFinding[];
  missing: Array<{ source: string; term: string; reason?: string }>;
}

export function findForbiddenTerms(texts: TextsInput, terms: TermInput[], options?: TermOptions): TermReport;
export function assertNoForbiddenTerms(texts: TextsInput, terms: TermInput[], options?: TermOptions): TermReport;
export function formatTermReport(report: TermReport): string;
export function findForbiddenTermsInFiles(options: TermOptions & {
  dirs: string[];
  terms: TermInput[];
  rootDir?: string;
  include?: (name: string, fullPath: string) => boolean;
  skippedDirs?: string[];
}): TermReport & { fileCount: number };

/* ---- évaluation des IA (promptfoo) ---- */

export interface EvalProviderInput {
  /** Identifiant promptfoo : `openai:chat:local`, `echo`, `openai:chat:gpt-…`. */
  id: string;
  /** Serveur compatible OpenAI (llama.cpp, LiteLLM…). */
  baseUrl?: string;
  /** NOM de la variable d'environnement qui porte la clé (jamais la clé elle-même). */
  apiKeyEnv?: string;
  model?: string;
  config?: Record<string, unknown>;
}
export interface EvalConfigInput {
  cases?: string;
  prompt?: string;
  providers?: Array<string | EvalProviderInput>;
  outputDir?: string;
  /** Part minimale de cas réussis, entre 0 et 1 (défaut 1). */
  minPassRate?: number;
}
export interface EvalCase {
  description?: string;
  vars: Record<string, unknown>;
  assert: Array<{ type: string; value?: unknown; [key: string]: unknown }>;
}
export interface EvalSummary {
  provider: string;
  passed: number;
  failed: number;
  errors: number;
  total: number;
  passRate: number;
  failures: Array<{ description: string; reason: string }>;
}
export interface EvalResult extends CommandResult {
  summaries: EvalSummary[];
  resultFile: string;
  configFile: string;
}
export const EVAL_DEFAULTS: Required<EvalConfigInput>;
export function loadCases(file: string): { cases: EvalCase[]; prompt: string | null };
export function buildProvider(input: Partial<EvalProviderInput>): string | { id: string; config: Record<string, unknown> };
export function buildPromptfooConfig(input: { description: string; prompt: string; providers: unknown[]; cases: EvalCase[] }): Record<string, unknown>;
export function findPromptfoo(rootDir: string): string | null;
export function summarizeEval(result: unknown): EvalSummary[];
export function runEval(rootDir: string, config: AstratraConfig, options?: {
  cases?: string;
  provider?: string;
  'base-url'?: string;
  'api-key-env'?: string;
  model?: string;
  'min-pass'?: string | number;
  out?: string;
  output?: Pick<Console, 'log'>;
  promptfooEntry?: string;
  runProcess?: (command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; quiet?: boolean }) => Promise<{ code: number | null; stdout?: string; stderr?: string }>;
}): Promise<EvalResult>;
