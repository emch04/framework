/**
 * Carte à tampons : N visites honorées dans une fenêtre de temps ouvrent droit
 * à une récompense ; une fois la récompense consommée, le compteur repart à
 * zéro immédiatement.
 *
 * Le cycle n'est pas une fenêtre glissante. Il s'ouvre à la première visite
 * comptée, dure la fenêtre choisie, puis se referme : ce qui n'a pas atteint
 * le seuil dans l'intervalle est perdu, et la visite suivante ouvre un cycle
 * neuf. Un client qui vient six fois puis disparaît ne capitalise pas
 * indéfiniment.
 *
 * Les dates sont des jours civils au format AAAA-MM-JJ : la règle compte des
 * visites, pas des instants, et un fuseau horaire ne doit jamais faire changer
 * une visite de cycle.
 */

const STATUTS_RECOMPENSE = ['available', 'reserved', 'used', 'lost'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function verifierDate(date, champ) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new TypeError(`${champ} doit être une date AAAA-MM-JJ (reçu : ${date}).`);
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.threshold=7]  visites nécessaires pour la récompense.
 * @param {{months?: number, days?: number}} [options.window={months: 3, days: 15}]
 *        durée d'un cycle, comptée depuis sa première visite.
 */
function createStampCard({ threshold = 7, window: fenetre = { months: 3, days: 15 } } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) throw new TypeError('threshold doit être un entier positif.');
  const mois = fenetre.months || 0;
  const jours = fenetre.days || 0;
  if (mois < 0 || jours < 0 || (mois === 0 && jours === 0)) {
    throw new TypeError('window doit durer au moins un jour.');
  }

  /**
   * Fin du cycle ouvert le `start` (exclue).
   * Le décalage de mois est plafonné au dernier jour du mois d'arrivée : sans
   * ça, un cycle ouvert un 30 novembre tomberait sur un 30 février inexistant,
   * que JavaScript reporterait silencieusement en mars.
   */
  function cycleEnd(start) {
    verifierDate(start, 'start');
    const [annee, moisDebut, jour] = start.split('-').map(Number);
    const cible = new Date(Date.UTC(annee, moisDebut - 1 + mois, 1));
    const dernierJour = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
    cible.setUTCDate(Math.min(jour, dernierJour));
    cible.setUTCDate(cible.getUTCDate() + jours);
    return `${cible.getUTCFullYear()}-${pad(cible.getUTCMonth() + 1)}-${pad(cible.getUTCDate())}`;
  }

  /* Une visite récompense consommée reste dans l'historique, mais sépare deux
     cycles et ne rapporte aucun tampon. `redeemed: true` la désigne ; à
     défaut (données anciennes), l'identifiant gardé sur une récompense
     utilisée permet de la reconnaître. */
  function estRecompenseConsommee(visite, reward) {
    if (visite.redeemed === true) return true;
    return reward?.status === 'used' && reward.visitId != null && String(reward.visitId) === String(visite.id);
  }

  /**
   * @param {object} input
   * @param {Array<{date: string, id?: string, redeemed?: boolean}>} input.visits
   * @param {{status?: string, cycleStart?: string, visitId?: string}} [input.reward]
   *        la récompense déjà inscrite pour ce client, s'il y en a une.
   */
  function evaluate({ visits = [], reward = null } = {}) {
    const historique = visits
      .filter((visite) => visite && visite.date)
      .map((visite) => {
        verifierDate(visite.date, 'visit.date');
        return visite;
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));

    let dernierSeparateur = -1;
    historique.forEach((visite, index) => {
      if (estRecompenseConsommee(visite, reward)) dernierSeparateur = index;
    });
    const comptees = historique
      .slice(dernierSeparateur + 1)
      .filter((visite) => !estRecompenseConsommee(visite, reward));

    if (!comptees.length) {
      return { cycleStart: null, cycleEnd: null, count: 0, remaining: threshold, reached: false, shouldGrant: false };
    }

    // Le cycle courant se retrouve en repartant de la première visite : chaque
    // visite tombée hors du cycle en cours en ouvre un nouveau.
    let debut = comptees[0].date;
    for (const visite of comptees) {
      if (visite.date >= cycleEnd(debut)) debut = visite.date;
    }
    const fin = cycleEnd(debut);
    const count = comptees.filter((visite) => visite.date >= debut && visite.date < fin).length;
    const reached = count >= threshold;

    /* Une récompense déjà inscrite sur ce cycle — disponible, réservée,
       utilisée ou perdue — ne se réaccorde pas : les visites suivantes du même
       cycle n'en valent pas une seconde, et une récompense manquée ne se
       rattrape pas. */
    const dejaInscrite = Boolean(reward?.status && reward.cycleStart === debut);

    return {
      cycleStart: debut,
      cycleEnd: fin,
      count,
      remaining: Math.max(0, threshold - count),
      reached,
      shouldGrant: reached && !dejaInscrite
    };
  }

  /** La récompense peut-elle être utilisée maintenant ? */
  function isRewardAvailable(reward) {
    return reward?.status === 'available';
  }

  return { threshold, cycleEnd, evaluate, isRewardAvailable };
}

const { createMonthlyPass, SCAN_DECISIONS } = require('./monthlyPass');

module.exports = { createStampCard, REWARD_STATUSES: STATUTS_RECOMPENSE, createMonthlyPass, SCAN_DECISIONS };
