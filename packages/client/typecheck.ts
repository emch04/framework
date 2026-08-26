import {
  SessionExpiredError,
  createMemoryQueueStore,
  createOfflineQueue,
  createPasswordRules,
  createRouteGuard,
  createSessionClient,
  createSupportLink,
  createHomeRoutes,
  createSettingsMenu,
  createToolCatalog,
  readResourceItems,
  readResourceSubtitle,
  readResourceTitle
} from './src';
import type {
  OfflineQueue,
  PasswordRules,
  QueueStore,
  ReplayReport,
  RouteGuard,
  SessionClient,
  SupportLink,
  HomeRoutes,
  SettingsMenu,
  Tool,
  ToolCatalog
} from './src';

/* ───────────────── Session, routes and passwords ───────────────── */

interface ApiResponse { ok: boolean; data?: unknown }
interface ApiInit { method?: string; body?: unknown }

const session: SessionClient<ApiResponse, ApiInit> = createSessionClient<ApiResponse, ApiInit>({
  request: async (path, init) => ({ ok: true, data: [path, init] }),
  refresh: async () => {},
  excluded: ['/auth/refresh', '/auth/login'],
  onSessionExpired: (cause) => void cause,
  isAuthError: (error) => (error as { status?: number }).status === 401
});

const guard: RouteGuard = createRouteGuard({
  publicSegments: ['home', 'login', 'reset-password'],
  loginRoute: '/login',
  emptyIsPublic: true
});

const rules: PasswordRules = createPasswordRules({
  minLength: 10,
  conditions: [{ key: 'length', test: (value, { minLength }) => value.length >= minLength }]
});

/* ─────────────────────── Offline queue ─────────────────────── */

const store: QueueStore = createMemoryQueueStore();

const queue: OfflineQueue = createOfflineQueue({
  store,
  handlers: {
    mark_attendance: async (payload, action) => void [payload, action.queuedAt]
  },
  isRejection: (error) => (error as { status?: number }).status === 409,
  onRejected: (action, error) => void [action.type, error],
  logger: { warn: () => {}, error: () => {} }
});

async function exercise(): Promise<void> {
  const response: ApiResponse = await session.call('/students', { method: 'GET' });
  await session.refreshOnce();
  try {
    await session.call('/x');
  } catch (error) {
    if (error instanceof SessionExpiredError) void error.code;
  }

  const redirect: boolean = guard.shouldRedirectToLogin({ isLoading: false, isAuthenticated: false, route: ['dashboard'] });
  const ticks = rules.check('Abcdef1!');

  await queue.enqueue('mark_attendance', { student: 's1', state: 'present' });
  const report: ReplayReport = await queue.replay();
  const waiting = await queue.pending();

  void [
    response.ok, redirect, guard.isPublicRoute('/login'), guard.loginRoute,
    ticks[0]?.met, rules.strength('x'), rules.canSubmit('a', 'a'), rules.keys,
    report.applied, report.halted, waiting.length
  ];
}

void exercise;

/* ──────────────────────── Writing to support ──────────────────────── */

const support: SupportLink = createSupportLink({
  email: 'support@acme.cd',
  fields: [{ key: 'name', label: 'Nom' }],
  separator: '—'
});

const signature: string = support.body({ name: 'Jean' }, { name: 'Name' });
const helpLink: string = support.mailto('Problème', signature, support.email);

void [signature, helpLink];

/* ─────────────────── Catalogue and payloads ─────────────────── */

const tools: Tool[] = [
  { id: 'orders', path: '/orders', roles: ['owner'], titleKey: 'orders.title', kind: 'collection', endpoint: '/orders' },
  { id: 'billing', path: '/billing', roles: ['owner'] }
];

const catalog: ToolCatalog = createToolCatalog(tools);
const visible: readonly Readonly<Tool>[] = catalog.forRole('owner');
const one: Readonly<Tool> | undefined = catalog.byId('orders');
const rows: Record<string, unknown>[] = readResourceItems({ orders: [{ id: 'o1' }] });
const title: string = readResourceTitle(rows[0]);
const subtitle: string = readResourceSubtitle(rows[0], ['status']);

void [
  visible.length, one?.path, catalog.hasPath('/orders'), catalog.canAccess(one, 'owner'),
  catalog.needsContext(catalog.byId('billing')), catalog.all.length, title, subtitle
];

/* ─────────────────── Menu and landing ─────────────────── */

const menu: SettingsMenu = createSettingsMenu({
  groups: ['account', 'shop'],
  sectionGroups: { profile: 'account' },
  fallbackGroup: 'account'
});

const home: HomeRoutes = createHomeRoutes({
  routes: { owner: '/dashboard' },
  fallback: '/home'
});

interface Section { id: string; labelKey: string }
const grouped = menu.group<Section>([{ id: 'profile', labelKey: 'profile' }]);

void [grouped[0]?.group, grouped[0]?.sections[0]?.labelKey, menu.groupOf('x'), home.forRole('owner'), home.fallback];
