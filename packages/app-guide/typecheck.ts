import {
  buildGuide,
  checkActionKeysInSources,
  checkI18nKeys,
  checkPageCoverage,
  checkRoutesExist,
  createTranslationResolver,
  createUsageQuestionDetector,
  filterGuideByRole,
  generateGuideJson,
  generateGuides,
  lookupGuide
} from './src';
import type { AppGuideConfig, AppGuide, GuideLookup } from './src';

const config: AppGuideConfig = {
  applicationKey: 'app.description',
  roles: {
    member: {
      tabs: ['nav.home'],
      sections: [{
        titleKey: 'section.work',
        items: [{ labelKey: 'page.orders', route: '/orders', visibleDirectly: false }]
      }],
      settingKeys: ['settings.language']
    }
  },
  tasks: [{
    id: 'create-order',
    keywordKeys: ['keywords.order'],
    roles: ['member'],
    stepKeys: ['steps.open-orders'],
    route: '/orders'
  }],
  pages: {
    '/orders': {
      purposeKey: 'orders.purpose',
      contentKeys: ['orders.content'],
      actions: [{ labelKey: 'orders.create', effectKey: 'orders.create_effect' }],
      sourceFiles: ['screens/orders.tsx']
    }
  }
};

const translate = createTranslationResolver({ app: { description: 'Mobile application' } });
const guide: AppGuide = buildGuide(config, translate);
const json: string = generateGuideJson(config, translate);
const files: Record<string, string> = generateGuides(config, { en: translate });
const role = filterGuideByRole(guide, 'member');
const lookup: GuideLookup | null = lookupGuide(guide, { role: 'member', question: 'orders', maxPages: 2 });
const detect = createUsageQuestionDetector({ patterns: { en: ['how (?:do|can) i'] } });
const usage: boolean = detect('How do I create one?', 'en');
const routesOk: boolean = checkRoutesExist(config, (route) => route === '/orders').ok;
const translationsOk: boolean = checkI18nKeys(config, () => true).ok;
const pagesOk: boolean = checkPageCoverage(config).ok;
const actionsOk: boolean = checkActionKeysInSources(config, {
  fileExists: () => true,
  readSource: () => "t('orders.create')"
}).ok;

void [json, files.en, role, lookup, usage, routesOk, translationsOk, pagesOk, actionsOk];
