/**
 * What the dashboard shows, as data.
 *
 * Declared here rather than inside the screen so that changing a product's
 * dashboard — or giving two roles two different ones — is an edit to a list,
 * never a rewrite of a component.
 *
 * Icons are SVG path strings: a list of data must not have to import React to
 * say what it looks like.
 */
import type { KpiItem } from '../components/dashboard/KpiBubble';
import type { StaffTab } from '../components/dashboard/StaffTabBar';
import type { ToolCardItem } from '../components/dashboard/ToolCard';

type Translate = (key: string) => string;

const ICONS = {
  people: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chart: 'M18 20V10M12 20V4M6 20v-6',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0'
};

/** Replace these with the numbers your API actually returns. */
export function dashboardKpis(t: Translate): KpiItem[] {
  return [
    { value: '—', label: t('dashboard.title'), color: '#3d5afe' },
    { value: '—', label: t('settings.title'), color: '#00b894' },
    { value: '—', label: t('notifications.title'), color: '#f39c12' }
  ];
}

export function dashboardTools(t: Translate): ToolCardItem[] {
  return [
    { label: t('settings.title'), value: '', color: '#3d5afe', path: '/settings', icon: ICONS.settings },
    { label: t('notifications.title'), value: '', color: '#f39c12', path: '/notifications', icon: ICONS.bell }
  ];
}

/**
 * The bottom bar. `key` picks the icon from the bar's own set — keep it to a
 * name that set knows, or the tab renders without one.
 */
export function dashboardTabs(t: Translate): StaffTab[] {
  return [
    { key: 'home', label: t('dashboard.title'), path: '/dashboard' },
    { key: 'messages', label: t('notifications.title'), path: '/notifications' },
    { key: 'more', label: t('settings.title'), path: '/settings' }
  ];
}
