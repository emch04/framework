import {
  CANCELLED_BY,
  COMPLETED,
  DEFAULT_GRACE_MS,
  DELETION_REASONS,
  createAccountDeletion,
  createMemoryDeletionStore,
  ibanValid,
  isDeletionDue,
  luhnValid,
  DEFAULT_PATTERNS,
  DEFAULT_SECRET_KEYS,
  ErasureError,
  FAILED,
  PENDING,
  REJECTED,
  createAnonymizer,
  createDataExporter,
  createErasureWorkflow,
  createMemoryErasureStore,
  createRedactor,
  defaultToken
} from './src';
import type {
  AccountDeletion,
  DeletionRecord,
  DeletionStore,
  InspectionResult,
  SweepResult,
  AnonymisationResult,
  Anonymizer,
  DataExporter,
  ErasureRequest,
  ErasureStatus,
  ErasureStore,
  ErasureWorkflow,
  ExportFile,
  FieldRule,
  RedactionPattern,
  Redactor
} from './src';

const redactor: Redactor = createRedactor({
  extra: [{ name: 'matricule', pattern: /MAT-\d{4}/g, replacement: '[MATRICULE]' }],
  secretKeys: [...DEFAULT_SECRET_KEYS, 'sessionSecret'],
  mask: '[HIDDEN]',
  maxDepth: 10
});

const cleanedLine: string = redactor.redactString('jean@ecole.cd');
const cleaned: { email: string } = redactor.redact({ email: 'jean@ecole.cd' });
const known: RedactionPattern[] = [...DEFAULT_PATTERNS, ...redactor.patterns];

interface Subject { id: string; role: string }

const exporter: DataExporter<Subject> = createDataExporter<Subject>({
  sources: [
    { key: 'account', label: 'Profile', collect: async (subject) => ({ id: subject.id }) },
    { key: 'payments', label: 'Payments', elsewhere: 'held by the billing service' }
  ],
  logger: { error: () => {} }
});

const rules: Record<string, FieldRule> = {
  fullName: 'redact',
  phone: 'clear',
  parentName: 'Anonymised parent',
  email: (_value, { token }) => `erased-${token}@invalid`
};

const anonymizer: Anonymizer = createAnonymizer({
  fields: rules,
  placeholder: 'Anonymised',
  token: defaultToken,
  has: (record, field) => field in record,
  onAnonymised: async (record) => { record.tokenVersion = Number(record.tokenVersion || 0) + 1000; }
});

const store: ErasureStore = createMemoryErasureStore();

const workflow: ErasureWorkflow = createErasureWorkflow({
  store,
  erase: async (request: ErasureRequest) => anonymizer.anonymise({ id: request.subject } as Record<string, unknown>),
  now: () => new Date(),
  logger: { info: () => {}, error: () => {} }
});

const statuses: ErasureStatus[] = [PENDING, REJECTED, COMPLETED, FAILED];

async function exercise(): Promise<void> {
  const file: ExportFile = await exporter.export({ id: 'user-1', role: 'parent' });
  const result: AnonymisationResult = await anonymizer.anonymise({ fullName: 'Jean' });
  const request: ErasureRequest = await workflow.request({ subject: 'user-1', reason: 'leaving' });
  const approved = await workflow.approve(request.id, { reviewedBy: 'admin-9', note: 'checked' });
  const waiting: ErasureRequest[] = await workflow.pending();

  try {
    await workflow.load('missing');
  } catch (error) {
    if (error instanceof ErasureError) void error.statusCode;
  }

  void [cleanedLine, cleaned.email, known.length, file.complete, result.token, approved.request.status, waiting, statuses, exporter.sources, anonymizer.fields];
}

const inspected: InspectionResult<{ note: string }> = redactor.inspect({ note: '4111111111111111' });
const checks: boolean[] = [luhnValid('4111111111111111'), ibanValid('GB82WEST12345698765432'), inspected.clean];

const deletionStore: DeletionStore<string> = createMemoryDeletionStore<string>();

interface Notice { key: string; days?: number }

const deletion: AccountDeletion<string> = createAccountDeletion<string, Notice>({
  store: deletionStore,
  erase: async (subject) => anonymizer.anonymise({ id: subject }),
  graceMs: DEFAULT_GRACE_MS,
  reminderMs: null,
  canRequest: async (_subject, context) => (context.lastAdministrator ? 'last_manager' : null),
  suspend: async () => {},
  restore: async () => {},
  notify: {
    send: async (_subject, message: Notice, event) => { void [message.key, event]; return true; },
    messages: { scheduled: (context) => ({ key: 'scheduled', days: context.daysLeft }) }
  },
  lock: { run: async (_name, _holdMs, fn) => fn() },
  staleClaimMs: 60_000,
  now: () => new Date()
});

async function exerciseDeletion(): Promise<void> {
  const requested = await deletion.request('user-1', { lastAdministrator: false });
  if (requested.ok) {
    const record: DeletionRecord<string> = requested.record;
    void [record.scheduledFor, isDeletionDue(record)];
  } else if (requested.reason === DELETION_REASONS.ALREADY_REQUESTED) {
    void requested.reason;
  }
  const cancelled = await deletion.cancel('user-1', { by: CANCELLED_BY.USER });
  const signIn = await deletion.onSignIn('user-1');
  const pass: SweepResult = await deletion.sweep();
  const suspended: boolean = await deletion.isSuspended('user-1');
  void [cancelled.cancelled, signIn.error, pass.ran, suspended, (await deletion.status('user-1')).scheduledFor];
}

void exercise;
void exerciseDeletion;
void checks;

import {
  CONSENT_CODES,
  ConsentError,
  consentAudience,
  consentCopyKeys,
  consentDialogActions,
  consentRecord,
  consentState,
  createConsent,
  createConsentClient,
  createMemoryConsentStore,
  mergeDecisions,
  newDecision,
  readConsentInput,
  readDecision,
  runConsentStoreContract
} from './src';
import type { Consent, ConsentClient, ConsentDecision, ConsentStore, ConsentVerdict } from './src';

const consentStore: ConsentStore = createMemoryConsentStore();
const consent: Consent = createConsent({
  store: consentStore,
  scopes: { ai: { version: 2 }, web: { version: 1, requires: ['ai'] } },
  now: () => new Date(),
  onChange: ({ subject, scope, granted, version }) => void [subject, scope, granted, version]
});

const consentClient: ConsentClient = createConsentClient({
  version: 2,
  local: { get: async () => null, set: async () => {} },
  remote: { get: async () => null, put: async (body) => body },
  currentSubject: () => 'user-1',
  onError: (where) => void where
});

async function exerciseConsent(): Promise<void> {
  const granted: ConsentDecision = await consent.grant('user-1', 'ai', { version: 2 });
  await consent.revoke('user-1', 'web');
  const verdict: ConsentVerdict = await consent.guard('user-1', ['web']);
  if (!verdict.allowed) void [verdict.code, verdict.scope];
  await consent.assert('user-1', 'ai').catch((error: unknown) => { if (error instanceof ConsentError) void error.statusCode; });
  const send = consent.guarded('ai', (id: string) => id, async (_id: string) => 'sent');
  const sent = await send('user-1');
  const overview = await consent.overview('user-1');
  await consent.forget('user-1');
  await consentClient.require();
  const ok: boolean = await consentClient.isGranted('user-1');
  const merged = mergeDecisions(readDecision(granted), 'unavailable');
  void [sent, overview.length, ok, merged.push, consentClient.stateOf(), CONSENT_CODES.REQUIRED,
    consentState(granted, 2), newDecision(true, 2), readConsentInput({}), consentAudience('student', { simple: ['student'] }),
    consentCopyKeys('ai', 'simple').title, consentDialogActions('refused').secondary, consentRecord({ scope: 'web' }), consent.versionOf('ai')];
}
void exerciseConsent;
void runConsentStoreContract;
