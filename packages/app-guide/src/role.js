'use strict';

function filterGuideByRole(guide, role) {
  const roleGuide = guide?.roles?.[role];
  if (!roleGuide) return null;

  const routes = new Set();
  for (const section of roleGuide.sections || []) {
    for (const item of section.items || []) if (item.route) routes.add(item.route);
  }
  for (const task of guide.tasks || []) {
    if (task.roles.includes(role) && task.route) routes.add(task.route);
  }

  return {
    application: guide.application,
    role,
    navigation: roleGuide,
    /* Filtering before lookup prevents a high-scoring task from leaking a
       workflow that this role cannot actually perform. */
    tasks: (guide.tasks || []).filter((task) => task.roles.includes(role)),
    pages: Object.fromEntries(Object.entries(guide.pages || {}).filter(([route]) => routes.has(route)))
  };
}

module.exports = { filterGuideByRole };
