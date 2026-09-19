'use strict';

const { filterGuideByRole } = require('./role');

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .trim();
}

function containsPhrase(question, candidate) {
  const term = normalize(candidate);
  return term.length > 1 && ` ${question} `.includes(` ${term} `);
}

function lookupGuide(guide, options = {}) {
  const filtered = filterGuideByRole(guide, options.role);
  if (!filtered) return null;

  const question = normalize(options.question);
  const maxTasks = options.maxTasks ?? 2;
  const maxPages = options.maxPages ?? 2;
  const maxPaths = options.maxPaths ?? 5;
  const tasks = filtered.tasks
    .map((task) => ({ task, score: task.keywords.filter((keyword) => containsPhrase(question, keyword)).length }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    /* A whole guide in an AI prompt made answers slower and less precise; the
       caller controls a hard bound instead of trusting relevance scoring. */
    .slice(0, maxTasks)
    .map(({ task }) => task);

  const pages = [];
  const paths = [];
  const seenRoutes = new Set();
  for (const section of filtered.navigation.sections || []) {
    for (const item of section.items || []) {
      if (!containsPhrase(question, item.name)) continue;
      if (paths.length < maxPaths) {
        paths.push({
          section: section.title,
          item: item.name,
          viaOverflow: !item.visibleDirectly,
          route: item.route
        });
      }
      if (item.route && !seenRoutes.has(item.route) && filtered.pages[item.route] && pages.length < maxPages) {
        seenRoutes.add(item.route);
        pages.push({ route: item.route, ...filtered.pages[item.route], displayName: item.name });
      }
    }
  }

  for (const setting of filtered.navigation.settings || []) {
    if (paths.length >= maxPaths) break;
    if (containsPhrase(question, setting)) paths.push({ setting });
  }
  for (const tab of filtered.navigation.tabs || []) {
    if (paths.length >= maxPaths) break;
    if (containsPhrase(question, tab)) paths.push({ tab });
  }

  return {
    role: filtered.role,
    tasks,
    pages,
    paths,
    fallback: tasks.length === 0 && pages.length === 0 && paths.length === 0 ? filtered.navigation : null
  };
}

module.exports = { normalize, lookupGuide };
