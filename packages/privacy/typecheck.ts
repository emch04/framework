import {
  COMPLETED,
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

void exercise;
