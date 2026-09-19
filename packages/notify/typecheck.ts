import {
  DEFAULT_THEME,
  createCaptureChannel,
  createInboxHandlers,
  createMailer,
  createMemoryInboxStore,
  createNotificationCatalog,
  createNotificationInbox,
  createPushSender,
  createSmsSender,
  escapeHtml,
  formatSender,
  hasHeaderInjection,
  mountInbox,
  normalizePhone,
  renderEmail,
  renderText,
  sanitizeAddress,
  sanitizeHeader
} from './src';
import type {
  CaptureChannel,
  EmailBlock,
  EmailTheme,
  InboxHandlers,
  InboxPage,
  InboxItem,
  MemoryInboxStore,
  NotificationCatalog,
  NotificationCatalogAudit,
  NotificationInbox,
  RenderedNotification,
  MailChannel,
  Mailer,
  OutgoingMessage,
  PushReport,
  PushSender,
  SendResult,
  SmsResult,
  SmsSender
} from './src';

/* ───────────────────────────── Email ───────────────────────────── */

const capture: CaptureChannel = createCaptureChannel({ from: 'no-reply@acme.cd', fromName: 'Acme' });

const smtp: MailChannel = {
  from: 'alerts@acme.cd',
  fromName: 'Acme Alerts',
  send: async (message: OutgoingMessage) => void message.subject
};

const mailer: Mailer = createMailer({
  channels: { transactional: capture, alerts: smtp },
  defaultChannel: 'transactional',
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  subjectMaxLength: 200
});

const theme: EmailTheme = { accent: '#2563eb', width: 620 };

const blocks: EmailBlock[] = [
  { type: 'heading', text: 'Bonjour' },
  { type: 'paragraph', text: 'Votre code :' },
  { type: 'code', value: '482915' },
  { type: 'divider' },
  { type: 'button', label: 'Ouvrir', url: 'https://app.acme.cd' },
  { type: 'note', text: 'Valable dix minutes.' },
  { type: 'html', html: '<em>brut</em>' }
];

const html: string = renderEmail({ blocks, preheader: 'Votre code', footer: 'Acme', theme });
const text: string = renderText({ blocks });

const safeSubject: string = sanitizeHeader('Commande confirmée', { maxLength: 120 });
const address: string | null = sanitizeAddress('jean@ecole.cd');
const sender: string | null = formatSender('no-reply@acme.cd', 'Acme');
const suspicious: boolean = hasHeaderInjection('Commande');
const escaped: string = escapeHtml('Dupont & Fils');

/* ────────────────────────── SMS and push ────────────────────────── */

const sms: SmsSender = createSmsSender({
  transport: async ({ to, text: body }) => void [to, body],
  maxLength: 320,
  logger: { info: () => {}, warn: () => {}, error: () => {} }
});

interface Subscription { id: string; endpoint: string }
interface Payload { title: string; body: string }

const push: PushSender<Subscription, Payload> = createPushSender<Subscription, Payload>({
  transport: async (subscription, payload) => void [subscription.endpoint, payload.title],
  isGone: (error) => (error as { statusCode?: number }).statusCode === 410,
  onGone: async (subscription) => void subscription.id,
  concurrency: 10,
  timeoutMs: 30_000
});

/* ───────────────────── Inbox and translated catalogue ───────────────────── */

const inboxStore: MemoryInboxStore = createMemoryInboxStore();
inboxStore.add({ id: 'n1', ownerId: 'u1', title: 'Hello' });
const inbox: NotificationInbox = createNotificationInbox({ store: inboxStore, pageSize: 20, maxPageSize: 50, isValidId: (id) => typeof id === 'string' });
const handlers: InboxHandlers = createInboxHandlers(inbox, {
  owner: (req) => req.user?.id,
  respond: (res, status, body) => res.status(status).json(body),
  notFoundMessage: 'Not found.'
});
const router = mountInbox({ get: () => undefined, patch: () => undefined, delete: () => undefined }, handlers);

const catalog: NotificationCatalog = createNotificationCatalog({
  languages: ['en', 'fr'],
  entries: [
    { result: { en: (p: { name: string }) => ({ title: 'Result', message: `${p.name} passed.`, pushBody: 'Open the app.' }) } },
    { invoice: { en: { title: 'Invoice due', message: 'An invoice is waiting.' } } }
  ]
});
const rendered: RenderedNotification = catalog.render('result', 'fr', { name: 'Ada' });
const catalogAudit: NotificationCatalogAudit = catalog.audit({ params: { result: { name: 'Ada' } } });

async function exercise(): Promise<void> {
  const page: InboxPage<InboxItem> = await inbox.list('u1', { page: 1, limit: 10 });
  const removed = await inbox.remove('u1', 'n1');
  const tidied = await inbox.removeRead('u1');
  void [page.pagination.totalPages, removed.removed, tidied.deleted, router, rendered.push.body, catalogAudit.pushBodyGaps, catalog.keys()];

  const mailResult: SendResult = await mailer.send({
    to: ['jean@ecole.cd'], subject: safeSubject, text, html, channel: 'alerts', replyTo: 'contact@acme.cd'
  });
  const last: OutgoingMessage | null = capture.last();
  capture.clear();

  const smsResult: SmsResult = await sms.send('+243 810 000 000', 'Votre code : 482915');
  const one = await push.send({ id: 's1', endpoint: 'https://…' }, { title: 'Hé', body: '…' });
  const many: PushReport = await push.broadcast([], { title: 'Hé', body: '…' });

  void [
    mailResult.sent, last, address, sender, suspicious, escaped, mailer.channels, DEFAULT_THEME.width,
    smsResult.sent, one.status, many.gone, normalizePhone('06 12 34 56 78')
  ];
}

void exercise;
