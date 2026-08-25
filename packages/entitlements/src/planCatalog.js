/**
 * Which plan unlocks what.
 *
 * The heart of any subscription product, and the part that quietly rots: a
 * feature list drifts between the pricing page, the API guard and the UI until
 * three answers exist for one question. One catalogue, consulted everywhere,
 * is the whole idea.
 *
 * Astratra ships no plans of its own. `starter`/`pro`/`enterprise` is one
 * product's vocabulary; `solo`/`team`/`business` is another's. Plans are
 * strings you choose, features are strings you choose.
 */

/**
 * @param {object} options
 * @param {Record<string, string[]>} options.plans  plan -> features it unlocks.
 * @param {Record<string, string>} [options.labels] plan -> human name.
 * @param {Record<string, string>} [options.upgradePath] plan -> the next plan up.
 * @param {string} [options.fallbackPlan] used when an account carries an unknown plan.
 */
function createPlanCatalog(options = {}) {
  const plans = options.plans || {};
  const names = Object.keys(plans);
  if (!names.length) {
    throw new Error('createPlanCatalog requires at least one plan in options.plans.');
  }

  for (const [plan, features] of Object.entries(plans)) {
    if (!Array.isArray(features)) {
      throw new Error(`createPlanCatalog expects options.plans.${plan} to be an array of feature keys.`);
    }
  }

  const labels = options.labels || {};
  const upgradePath = options.upgradePath || {};

  /* An account can carry a plan the catalogue no longer knows — a renamed tier,
     a half-finished migration. Falling back to the smallest plan keeps the
     account working with the least access, which is the safe direction. */
  const fallbackPlan = options.fallbackPlan || names[0];
  if (!plans[fallbackPlan]) {
    throw new Error(`createPlanCatalog: options.fallbackPlan "${fallbackPlan}" is not one of the declared plans.`);
  }

  for (const [from, to] of Object.entries(upgradePath)) {
    if (!plans[from]) throw new Error(`createPlanCatalog: upgradePath mentions unknown plan "${from}".`);
    if (!plans[to]) throw new Error(`createPlanCatalog: upgradePath points "${from}" at unknown plan "${to}".`);
  }

  const featureSets = new Map(
    Object.entries(plans).map(([plan, features]) => [plan, new Set(features)])
  );

  const knows = (plan) => featureSets.has(plan);
  const resolve = (plan) => (knows(plan) ? plan : fallbackPlan);

  /**
   * Does this plan include this feature?
   *
   * `overrides` is what makes a catalogue survive contact with real customers:
   * one account negotiated a feature outside its tier, and hard-coding that
   * into the plan would hand it to everyone.
   */
  function hasFeature(plan, feature, overrides = []) {
    const set = featureSets.get(resolve(plan));
    return set.has(feature) || overrides.includes(feature);
  }

  return {
    plans: names,
    knows,
    fallbackPlan,
    hasFeature,
    featuresOf: (plan) => [...featureSets.get(resolve(plan))],
    labelOf: (plan) => labels[plan] || plan,
    upgradeFrom: (plan) => upgradePath[resolve(plan)] || null,
    /** Every feature any plan mentions — useful to catch typos in a guard. */
    allFeatures: () => [...new Set(Object.values(plans).flat())]
  };
}

module.exports = { createPlanCatalog };
