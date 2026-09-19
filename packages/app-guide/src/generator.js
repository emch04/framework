'use strict';

function translatedList(keys, translate) {
  return (keys || []).map((key) => translate(key));
}

function buildRoles(roles, translate) {
  return Object.fromEntries(Object.entries(roles || {}).map(([role, value]) => [role, {
    tabs: translatedList(value.tabs, translate),
    sections: (value.sections || []).map((section) => ({
      title: translate(section.titleKey),
      items: (section.items || []).map((item) => ({
        name: translate(item.labelKey),
        visibleDirectly: item.visibleDirectly !== false,
        ...(item.route ? { route: item.route } : {})
      }))
    })),
    settings: translatedList(value.settingKeys, translate)
  }]));
}

function buildPages(pages, roles, translate) {
  const namesByRoute = new Map();
  for (const role of Object.values(roles)) {
    for (const section of role.sections) {
      for (const item of section.items) {
        if (item.route && !namesByRoute.has(item.route)) namesByRoute.set(item.route, item.name);
      }
    }
  }

  return Object.fromEntries(Object.entries(pages || {}).map(([route, page]) => [route, {
    name: page.nameKey ? translate(page.nameKey) : (namesByRoute.get(route) || route),
    purpose: translate(page.purposeKey),
    content: translatedList(page.contentKeys, translate),
    actions: (page.actions || []).map((action) => ({
      label: translate(action.labelKey),
      effect: translate(action.effectKey)
    }))
  }]));
}

function buildGuide(config, translate) {
  if (!config || typeof config !== 'object') throw new TypeError('config must be an object');
  if (typeof translate !== 'function') throw new TypeError('translate must be a function');

  const roles = buildRoles(config.roles, translate);
  return {
    application: translate(config.applicationKey),
    roles,
    tasks: (config.tasks || []).map((task) => ({
      id: task.id,
      keywords: translatedList(task.keywordKeys, translate),
      roles: [...(task.roles || [])],
      steps: translatedList(task.stepKeys, translate),
      route: task.route
    })),
    pages: buildPages(config.pages, roles, translate)
  };
}

function generateGuideJson(config, translate, options = {}) {
  const space = options.space === undefined ? 2 : options.space;
  return `${JSON.stringify(buildGuide(config, translate), null, space)}\n`;
}

function generateGuides(config, languages, options = {}) {
  return Object.fromEntries(Object.entries(languages || {}).map(([language, translate]) => [
    language,
    generateGuideJson(config, translate, options)
  ]));
}

module.exports = { buildGuide, generateGuideJson, generateGuides };
