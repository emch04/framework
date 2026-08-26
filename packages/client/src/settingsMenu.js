/**
 * The settings index, grouped.
 *
 * A flat list of sections — profile, billing, security, help — tells nobody
 * what is theirs and what belongs to the organisation. Grouping is the whole
 * feature, and two rules make it trustworthy:
 *
 * THE ORDER IS THE DECLARED ONE, not the order sections happen to arrive in.
 * A settings screen that reorders itself between two loads is disorienting.
 *
 * AN UNKNOWN SECTION IS STILL SHOWN. Dropping what the map does not know makes
 * a section added later vanish from the app with no error anywhere. Misplaced
 * is a cosmetic problem; invisible is a missing feature.
 */

/**
 * @param {object} options
 * @param {string[]} options.groups  Group ids, in render order.
 * @param {Object<string,string>} [options.sectionGroups]  sectionId => group.
 * @param {string} [options.fallbackGroup]  Default: the first group.
 */
function createSettingsMenu(options = {}) {
  const groups = Array.isArray(options.groups) ? options.groups.filter(Boolean) : [];
  if (!groups.length) throw new Error('createSettingsMenu requires a non-empty options.groups.');

  const fallbackGroup = options.fallbackGroup || groups[0];
  if (!groups.includes(fallbackGroup)) {
    throw new Error(`createSettingsMenu: fallbackGroup "${fallbackGroup}" is not one of the declared groups.`);
  }

  const sectionGroups = options.sectionGroups || {};

  function groupOf(sectionId) {
    const group = sectionGroups[sectionId];
    return group && groups.includes(group) ? group : fallbackGroup;
  }

  /**
   * @param {Array<{id: string}>} sections
   * @returns {Array<{group: string, sections: object[]}>} empty groups omitted.
   */
  function group(sections) {
    const buckets = new Map();
    for (const section of Array.isArray(sections) ? sections : []) {
      if (!section || !section.id) continue;
      const key = groupOf(section.id);
      const list = buckets.get(key);
      if (list) list.push(section);
      else buckets.set(key, [section]);
    }
    return groups.flatMap((key) => {
      const list = buckets.get(key);
      return list && list.length ? [{ group: key, sections: list }] : [];
    });
  }

  return { groups, fallbackGroup, groupOf, group };
}

module.exports = { createSettingsMenu };
