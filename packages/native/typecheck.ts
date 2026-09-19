import {
  TRANSPORT_BLACKOUT_MS,
  UPDATE_APPLY_GRACE_MS,
  UPDATE_CHECK_INTERVAL_MS,
  MEDIA_CACHE_MAX_BYTES,
  contentKey,
  createConnectivityMonitor,
  createMediaCache,
  createUpdateWatcher,
  describeRelease,
  extensionFor,
  hasComeBack,
  planEviction,
  readConnectionLink,
  readReachability,
  shouldApplyUpdate,
  shouldCheckForUpdate,
  shouldDeclareTransportDown
} from './src';
import type {
  ConnectionLink,
  ConnectivityMonitor,
  FileSystemLike,
  MediaCache,
  NetInfoLike,
  Reachability,
  UpdateWatcher
} from './src';

import {
  FOREGROUND_POLL_MS,
  createBiometricGate,
  createNotificationRouter,
  blurPropsFor,
  createApiClient,
  createCheckoutOpener,
  createPushService,
  createPushSettingsController,
  createMemoryKeystore,
  createSecureSession,
  createWebKeystore,
  decideRegistrationAction,
  freshItems,
  isPushEnabled,
  nextStamp,
  resolveGlassMode,
  resolvePushAction,
  shouldPoll
} from './src';
import type {
  Authenticator,
  BiometricEnableResult,
  BiometricGate,
  BiometricState,
  GlassMode,
  ApiClient,
  BlurProps,
  CheckoutOpener,
  Keystore,
  NotificationRouter,
  PushAction,
  PushSettingsController,
  PushService,
  PushSettingsSnapshot,
  PushViewState,
  RegistrationAction,
  SecureSession,
  WatchedItem
} from './src';

/* ───────────────────────────── Session ───────────────────────────── */

const memory: Keystore = createMemoryKeystore();
const web: Keystore = createWebKeystore(typeof localStorage === 'undefined' ? null : localStorage);

const session: SecureSession = createSecureSession({ keystore: memory, namespace: 'acme' });

/* ──────────────────────────── Biometrics ─────────────────────────── */

const authenticator: Authenticator = {
  hasHardwareAsync: async () => true,
  isEnrolledAsync: async () => true,
  authenticateAsync: async (options) => ({ success: Boolean(options?.promptMessage) })
};

const gate: BiometricGate = createBiometricGate({
  keystore: web,
  authenticator,
  namespace: 'acme',
  promptMessage: 'Acme'
});

/* ─────────────────────────────── Glass ───────────────────────────── */

const mode: GlassMode = resolveGlassMode({
  platform: 'ios',
  apiAvailable: true,
  effectAvailable: true,
  blurAvailable: true
});

const blur: BlurProps = blurPropsFor('android', 30);

/* ────────────────────────── Push and watching ────────────────────────── */

const router: NotificationRouter = createNotificationRouter({
  fallback: '/notifications',
  routes: [{ pattern: /^\/orders\/([^/]+)$/, allow: (recipient, match) => Boolean(recipient) && match.length > 1 }],
  actions: { REFUND: (payload) => (typeof payload.orderId === 'string' ? `/orders/${payload.orderId}` : null) }
});

const registration: RegistrationAction = decideRegistrationAction({ explicit: true, permission: 'undetermined' });

const controller: PushSettingsController = createPushSettingsController(
  {
    getState: async () => 'enabled',
    enable: async () => undefined,
    disable: async () => undefined,
    openSettings: async () => undefined
  },
  (snapshot: PushSettingsSnapshot) => void snapshot.busy
);

type Bell = WatchedItem & { id: string };
const items: Bell[] = [{ id: 'n1', createdAt: '2026-08-26T10:00:00.000Z', read: false }];
const fresh: Bell[] = freshItems(items, '2026-08-26T09:00:00.000Z');
const stamp: string | null = nextStamp(items, null);
const polling: boolean = shouldPoll('active', true);
const view: PushViewState = 'loading';
const pushAction: PushAction | null = resolvePushAction(view);

const checkout: CheckoutOpener = createCheckoutOpener({
  linking: { openURL: async (url: string) => url },
  loadBrowser: () => ({ openBrowserAsync: async (url: string) => url }),
  browserOptions: { showTitle: true }
});

const push: PushService = createPushService({
  namespace: 'acme',
  load: async () => ({
    platform: 'ios',
    isDevice: true,
    deviceName: 'iPhone',
    randomUUID: () => 'uuid',
    keystore: memory,
    projectId: async () => 'project-1',
    notifications: {},
    channels: [{ id: 'acme-orders', name: 'Orders' }],
    categories: [{ id: 'order', actions: [] }],
    router,
    navigate: (route: string) => void route,
    onAction: async () => false,
    api: {
      register: async () => ({ registered: true, enabled: true }),
      current: async () => ({ registered: true, enabled: true }),
      unregister: async () => undefined
    }
  })
});

const api: ApiClient = createApiClient({
  baseUrl: 'https://api.acme.com/api',
  session,
  language: () => 'fr',
  platform: 'mobile',
  refresh: async () => undefined,
  excluded: ['/auth/register'],
  onSessionExpired: () => undefined
});

async function exercise(): Promise<void> {
  const order = await api.request<{ id: string }>('/orders/o1');
  const asset: string | undefined = api.resolveAssetUrl('/uploads/a.png');
  const pushState = await push.getState();
  const stopListening: () => void = await push.startListeners('seller');
  stopListening();
  await push.logout(async () => undefined);
  push.allowRegistration();
  const returned: boolean = await checkout('https://pay.example/x', 'acme://paid');
  await session.save({ accessToken: 'a', refreshToken: 'r' });
  const access: string | null = await session.getAccessToken();
  const refresh: string | null = await session.getRefreshToken();
  await session.clear();
  session.forget();

  const state: BiometricState = await gate.read();
  const enabled: BiometricEnableResult = await gate.enable({ promptMessage: 'Acme' });
  await gate.disable();
  const unlocked: boolean = await gate.confirm();

  const screen = controller.activate();
  await screen.ready;
  await controller.refresh();
  await controller.act();
  screen.dispose();

  void [
    access, refresh, session.keys.access, state.supported, enabled.failed, unlocked, gate.key, mode,
    router.resolve('/orders/o1', 'seller'), router.resolveAction({ actionIdentifier: 'REFUND', orderId: 'o1' }, 'seller'),
    router.fallback, registration, returned, blur.intensity, order.id, asset, pushState, await push.getInstallationId(), fresh.length, stamp, polling, pushAction, isPushEnabled(view), FOREGROUND_POLL_MS
  ];
}

void exercise;

/* ──────────────────── Connectivity, updates, media cache ──────────────────── */

const netInfo: NetInfoLike = {
  addEventListener: () => () => undefined,
  fetch: async () => ({ isConnected: true, isInternetReachable: null, type: 'wifi' })
};
const network: ConnectivityMonitor = createConnectivityMonitor({ netInfo, blackoutMs: TRANSPORT_BLACKOUT_MS });
network.setRecoveryProbe(async () => undefined);
const unsubscribeNetwork: () => void = network.subscribe(() => undefined);
const reach: Reachability = readReachability({ isConnected: true, isInternetReachable: false });
const link: ConnectionLink = readConnectionLink(null);
const declare: boolean = shouldDeclareTransportDown({ reason: 'timeout', reachability: reach });

const watcher: UpdateWatcher = createUpdateWatcher({
  updates: {
    isEnabled: true,
    isEmbeddedLaunch: false,
    updateId: null,
    checkForUpdateAsync: async () => ({ isAvailable: false }),
    fetchUpdateAsync: async () => ({ isNew: false }),
    reloadAsync: async () => undefined
  },
  appState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  isOnline: network.shouldAttemptRequest,
  pendingWrites: () => 0,
  onError: (_error, context) => void context.where,
  graceMs: UPDATE_APPLY_GRACE_MS
});
const due: boolean = shouldCheckForUpdate({ enabled: true, online: true, lastCheckAt: null, now: 0 }, UPDATE_CHECK_INTERVAL_MS);
const apply: boolean = shouldApplyUpdate({ downloaded: true, stillInBackground: true, pendingWrites: 0 });
const release: string = describeRelease({ version: '1.0.0', updateId: null, isEmbeddedLaunch: true });

const fsAdapter: FileSystemLike = {
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => undefined,
  moveAsync: async () => undefined,
  deleteAsync: async () => undefined,
  readDirectoryAsync: async () => []
};
const media: MediaCache = createMediaCache({ fs: fsAdapter, directory: 'file:///cache/media/', extensions: ['m4a'], maxBytes: MEDIA_CACHE_MAX_BYTES });
const key: string = contentKey('v1', 'en', 'text');
const extension: string = extensionFor('audio/mp4', { 'audio/mp4': 'm4a' }, 'wav');
const evicted: string[] = planEviction([{ name: 'a.m4a', size: 1, modifiedAt: 0 }], { extensions: ['m4a'] });

async function exerciseOffline(): Promise<void> {
  const worth: boolean = await network.refresh();
  const fetched: boolean = await watcher.check();
  const build = watcher.describeBuild('1.0.0');
  const uri: string = await media.resolve(key, async () => ({ extension, write: async () => undefined }));
  const removed: string[] = await media.tidy();
  unsubscribeNetwork();
  void [worth, fetched, build.release, uri, removed, link, declare, due, apply, release, evicted, hasComeBack('offline', reach)];
}

void exerciseOffline;
