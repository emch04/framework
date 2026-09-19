import { createElement } from 'react';
import {
  CollapsibleScreen,
  FloatingPagination,
  GlassButton,
  MarkdownView,
  PaleCard,
  TabBar,
  barScale,
  followScroll,
  getGlassMode,
  glassButtonMaterial,
  measureColumns,
  paleCardColors,
  parseMarkdown,
  reserveBelowQuestion,
  tintAtAppleWeight
} from './src';
import type { GlassMode, MarkdownBlock, TabBarTab } from './src';
import { arrangeTabs, INITIAL_COLLAPSE } from './src/logic';

const mode: GlassMode = getGlassMode();
glassButtonMaterial({ mode, scheme: 'dark', tinted: true }).glow?.shadowOpacity;
const tint: string = tintAtAppleWeight('rgba(255,255,255,0.4)', false);
void tint;
paleCardColors({ scheme: 'light', pageBackground: '#fff', ink: '#000', tint: null }).fill.toUpperCase();

const state = followScroll(INITIAL_COLLAPSE, 120);
void state.collapsed;
void barScale(430);

const blocks: MarkdownBlock[] = parseMarkdown('## Hi');
for (const block of blocks) if (block.kind === 'numbers') void block.start;
measureColumns(['A'], [['1']], { fontScale: 1.2, round: Math.round }).widths.at(0);
void reserveBelowQuestion({ viewportHeight: 700, contentHeight: 900, anchorY: 800 });

interface AppTab extends TabBarTab {
  path: string;
}
const tabs: AppTab[] = [{ key: 'home', label: 'Home', path: '/' }];
arrangeTabs(tabs, 'home').ordered[0].path.toString();

createElement(TabBar<AppTab>, { tabs, activeKey: 'home', onSelect: (tab) => void tab.path, centerKey: 'ai' });
createElement(GlassButton, { onPress: () => undefined, accessibilityLabel: 'Back', size: 40 });
createElement(PaleCard, { tint: '#3b6cf0' });
createElement(FloatingPagination, {
  page: 1,
  totalPages: 3,
  canPrevious: false,
  canNext: true,
  onPrevious: () => undefined,
  onNext: () => undefined,
  previousLabel: 'Previous',
  nextLabel: 'Next'
});
createElement(CollapsibleScreen, { title: 'Settings', largeTitle: 'Settings', topInset: 47 });
createElement(MarkdownView, { content: '**hi**', onCopyCode: async () => undefined });
