import {
  compareVersions,
  createMemoryAnnouncementStore,
  createStoreVersionWatcher,
  createVersionAnnouncer,
  createVersionHandler,
  defineVersionManifest,
  isAnnouncementEnabled,
  isBannerVisible,
  isBehind,
  startAnnouncementSchedule,
  toExpressHandler,
  versionStatus
} from './src';
import type {
  AnnouncementResult,
  StoreVersionSnapshot,
  StoreVersionWatcher,
  VersionManifest,
  VersionStatus
} from './src';

/* ───────────────────────────── Server ────────────────────────────── */

const manifest: VersionManifest = defineVersionManifest({
  ios: { latest: '1.1.4', minimum: '1.0.0', storeUrl: null },
  android: { latest: '1.1.4', minimum: '1.0.0', storeUrl: 'https://play.google.com/store/apps/details?id=com.acme' }
});

const handler = createVersionHandler({ versions: manifest });
const route = toExpressHandler(handler, { wrap: (data) => ({ data }) });
void route;

const order: -1 | 0 | 1 | null = compareVersions('1.10.0', '1.9.3');
const behind: boolean = isBehind(undefined, '1.2.0');
void order;
void behind;

interface Device { id: string; appVersion?: string | null; token: string }

const announcer = createVersionAnnouncer<Device, { category: string; route: string }>({
  versions: manifest,
  store: createMemoryAnnouncementStore(),
  listDevices: async () => [{ id: 'd1', appVersion: '1.0.0', token: 't' }],
  send: async (devices, message) => ({ sent: devices.length + message.title.length * 0, failed: 0 }),
  messages: { en: { title: 'New version', body: 'Version {version} is out.' } },
  payload: { category: 'app_update', route: '/update' },
  enabled: () => isAnnouncementEnabled(process.env)
});

const results: Promise<AnnouncementResult[]> = announcer.run();
void results;
startAnnouncementSchedule({ announcer, onError: () => {} }).stop();

/* ───────────────────────────── Client ────────────────────────────── */

const memory = new Map<string, string>();
const watcher: StoreVersionWatcher = createStoreVersionWatcher({
  fetchVersions: async () => manifest,
  storage: {
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => { memory.set(key, value); }
  },
  installedVersion: () => '1.1.3',
  platform: 'android',
  onForeground: () => ({ remove: () => {} })
});

const snapshot: StoreVersionSnapshot = watcher.getSnapshot();
const status: VersionStatus = versionStatus(snapshot.installed, snapshot.info);
const banner: boolean = isBannerVisible(status, snapshot.info?.latest, null);
void banner;
