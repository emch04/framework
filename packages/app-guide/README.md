# @astratra/app-guide

Build an AI-readable usage guide from the same screen configuration that drives
a mobile app. Roles, routes and translation keys stay in the application; this
package only turns them into a guide, filters it, searches it and checks that it
still matches the app.

The package has no filesystem, mobile or AI dependency. File access is injected
into coverage checks, and the generator returns JSON for the caller to write.

## Generate one guide per language

```js
const {
  createTranslationResolver,
  generateGuides
} = require('@astratra/app-guide');

const config = {
  applicationKey: 'guide.application',
  roles: {
    owner: {
      tabs: ['nav.home'],
      sections: [{
        titleKey: 'home.manage',
        items: [{ labelKey: 'orders.title', route: '/orders', visibleDirectly: false }]
      }],
      settingKeys: ['settings.language']
    }
  },
  tasks: [{
    id: 'create-order',
    keywordKeys: ['guide.keywords.create_order'],
    roles: ['owner'],
    stepKeys: ['guide.steps.open_orders', 'guide.steps.press_create'],
    route: '/orders'
  }],
  pages: {
    '/orders': {
      purposeKey: 'guide.orders.purpose',
      contentKeys: ['guide.orders.content'],
      actions: [{ labelKey: 'orders.create', effectKey: 'guide.orders.create_effect' }],
      sourceFiles: ['screens/orders.tsx']
    }
  }
};

const guides = generateGuides(config, {
  en: createTranslationResolver(enDictionary),
  es: createTranslationResolver(esDictionary)
});

// guides.en and guides.es are deterministic, newline-terminated JSON strings.
```

All user-visible text is resolved from caller-owned keys. The package does not
invent navigation labels, answer prefixes or fallback copy.

## Detect and answer usage questions

Patterns are supplied per language. String patterns receive a Unicode-aware
left boundary, so a phrase beginning with an accented letter is detected at the
start of a sentence.

```js
const {
  buildGuide,
  createUsageQuestionDetector,
  lookupGuide
} = require('@astratra/app-guide');

const isUsageQuestion = createUsageQuestionDetector({
  patterns: {
    en: ['how (?:do|can) i', 'where (?:is|can i)'],
    fr: ['comment (?:faire|puis-je)', '[àa] quoi sert']
  },
  fallbackLanguage: 'en'
});

const guide = buildGuide(config, createTranslationResolver(enDictionary));
const result = isUsageQuestion(question, 'en')
  ? lookupGuide(guide, { role: 'owner', question, maxTasks: 2, maxPages: 2 })
  : null;
```

`lookupGuide` returns structured tasks, page facts and navigation paths. The
caller formats those values for its assistant. Results are role-filtered and
bounded; when nothing matches, `fallback` contains only that role's real
navigation.

## Keep the guide aligned with the app

The checks return data instead of depending on a test framework:

```js
const {
  checkActionKeysInSources,
  checkI18nKeys,
  checkPageCoverage,
  checkRoutesExist
} = require('@astratra/app-guide');

expect(checkRoutesExist(config, routeExists).ok).toBe(true);
expect(checkI18nKeys(config, hasTranslation).ok).toBe(true);
expect(checkPageCoverage(config).ok).toBe(true);
expect(checkActionKeysInSources(config, {
  fileExists,
  readSource
}).ok).toBe(true);
```

- `checkRoutesExist` covers task routes and screen-card routes.
- `checkI18nKeys` covers every key consumed by generation.
- `checkPageCoverage` catches both missing fiches and orphaned fiches.
- `checkActionKeysInSources` proves that every documented action key still
  occurs in one of the page's caller-declared screen files.

The app owns the adapters, so these tests run in plain Node against React
Native, Expo or any other screen tree.
