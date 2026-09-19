'use strict';

function collectTranslationKeys(config) {
  const keys = new Set();
  const add = (key) => { if (typeof key === 'string' && key) keys.add(key); };
  add(config.applicationKey);
  for (const role of Object.values(config.roles || {})) {
    (role.tabs || []).forEach(add);
    (role.settingKeys || []).forEach(add);
    for (const section of role.sections || []) {
      add(section.titleKey);
      for (const item of section.items || []) add(item.labelKey);
    }
  }
  for (const task of config.tasks || []) {
    (task.keywordKeys || []).forEach(add);
    (task.stepKeys || []).forEach(add);
  }
  for (const page of Object.values(config.pages || {})) {
    add(page.nameKey);
    add(page.purposeKey);
    (page.contentKeys || []).forEach(add);
    for (const action of page.actions || []) {
      add(action.labelKey);
      add(action.effectKey);
    }
  }
  return [...keys];
}

function checkI18nKeys(config, hasTranslation) {
  const missing = collectTranslationKeys(config).filter((key) => !hasTranslation(key));
  return { ok: missing.length === 0, missing };
}

function checkRoutesExist(config, routeExists) {
  const routes = new Set();
  for (const task of config.tasks || []) if (task.route) routes.add(task.route);
  for (const role of Object.values(config.roles || {})) {
    for (const section of role.sections || []) {
      for (const item of section.items || []) if (item.route) routes.add(item.route);
    }
  }
  const missing = [...routes].filter((route) => !routeExists(route));
  return { ok: missing.length === 0, missing };
}

function checkPageCoverage(config) {
  const used = new Set();
  for (const role of Object.values(config.roles || {})) {
    for (const section of role.sections || []) {
      for (const item of section.items || []) if (item.route) used.add(item.route);
    }
  }
  const pages = new Set(Object.keys(config.pages || {}));
  /* Check both directions: only checking missing fiches left stale fiches in
     generated guides after a dashboard card was removed. */
  const missing = [...used].filter((route) => !pages.has(route));
  const orphaned = [...pages].filter((route) => !used.has(route));
  return { ok: missing.length === 0 && orphaned.length === 0, missing, orphaned };
}

function checkActionKeysInSources(config, adapters) {
  const missingFiles = [];
  const missingActionKeys = [];
  for (const [route, page] of Object.entries(config.pages || {})) {
    const sources = [];
    for (const file of page.sourceFiles || []) {
      if (!adapters.fileExists(file)) missingFiles.push({ route, file });
      else sources.push(adapters.readSource(file));
    }
    for (const action of page.actions || []) {
      /* Translation existence alone did not prove that a documented button
         still existed; its key must remain in an actual declared screen. */
      if (!sources.some((source) => source.includes(action.labelKey))) {
        missingActionKeys.push({ route, key: action.labelKey });
      }
    }
  }
  return {
    ok: missingFiles.length === 0 && missingActionKeys.length === 0,
    missingFiles,
    missingActionKeys
  };
}

module.exports = {
  collectTranslationKeys,
  checkI18nKeys,
  checkRoutesExist,
  checkPageCoverage,
  checkActionKeysInSources
};
