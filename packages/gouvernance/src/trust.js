'use strict';
const { honestStatistics, calibratePredictions } = require('@astratra/conscience/autoconscience');
const { GouvernanceError } = require('./errors');
const { LEVELS } = require('./levels');

/*
 * La confiance mesurée. Les règles s'assouplissent avec des preuves, jamais toutes seules : ce module ne fait que
 * PROPOSER (« sur ce type d'action, l'IA a eu raison 98 % du temps sur 120 cas : la passer en libre avec avis ? »).
 * Une personne décide, en changeant elle-même la règle.
 *
 * Une entrée par proposition, regroupée par type d'action : IA, ressource, opérations. L'issue compte :
 *  - `approved` : une personne a validé (et rien n'a été annulé ensuite) → l'IA avait raison ;
 *  - `declined` : refusée par une personne → l'IA avait tort ;
 *  - `undone` : exécutée puis annulée par une personne → l'IA avait tort ;
 *  - `unreviewed` : exécutée sans validation (niveau libre) et jamais annulée → comptée comme juste ;
 *  - `unknown` : rien de décidé (en attente, expirée, données changées avant l'écriture…) → hors des comptes.
 * Les statistiques sont celles de l'autoconscience (intervalle de Wilson, seuil d'effectif, calibration).
 */

const OUTCOMES = Object.freeze(['approved', 'declined', 'undone', 'unreviewed', 'unknown']);
const STATUS = { approved: 'succeeded', unreviewed: 'succeeded', declined: 'failed', undone: 'failed', unknown: 'unknown' };

function groupKey(entry) { return JSON.stringify([entry.agent, entry.resource, [...entry.ops].sort()]); }

/**
 * trustSuggestions(entries, { minimumSample = 30, loosenAbove = 0.9, tightenUndone = 3, tightenRate = 0.1, level = 0.95 })
 * entries : [{ id, agent, resource, ops, level, confidence?, outcome, at? }]
 * Rend un rapport par type d'action, avec au plus une suggestion :
 *  - assouplir `validation` → `free_with_notice` quand la borne basse de l'intervalle du taux de réussite atteint
 *    `loosenAbove`, sur au moins `minimumSample` décisions, sans aucune annulation ;
 *  - resserrer `free` ou `free_with_notice` → `validation` dès `tightenUndone` annulations et un taux d'erreur d'au
 *    moins `tightenRate`.
 * Jamais vers `free` directement, jamais depuis ni vers `forbidden` : ces choix restent ceux d'une personne.
 */
function trustSuggestions(entries, options = {}) {
  if (!Array.isArray(entries)) throw new GouvernanceError('invalid_trust_input', 'Une liste d\'entrées est attendue.');
  const minimumSample = options.minimumSample ?? 30;
  const loosenAbove = options.loosenAbove ?? 0.9;
  const tightenUndone = options.tightenUndone ?? 3;
  const tightenRate = options.tightenRate ?? 0.1;
  const level = options.level ?? 0.95;
  const groups = new Map();
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.agent !== 'string' || typeof entry.resource !== 'string' || !Array.isArray(entry.ops)) {
      throw new GouvernanceError('invalid_trust_input', 'Chaque entrée a un id, une IA, une ressource et des opérations.');
    }
    if (!OUTCOMES.includes(entry.outcome)) throw new GouvernanceError('invalid_trust_input', `Issue inconnue : ${String(entry.outcome)}.`);
    if (!LEVELS.includes(entry.level)) throw new GouvernanceError('invalid_trust_input', `Niveau inconnu : ${String(entry.level)}.`);
    if (entry.confidence != null && (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1)) {
      throw new GouvernanceError('invalid_trust_input', 'La confiance va de 0 à 1.');
    }
    /* Une proposition ne compte qu'une fois par type d'action. */
    const mark = `${groupKey(entry)}\u0000${entry.id}`;
    if (seen.has(mark)) continue;
    seen.add(mark);
    const key = groupKey(entry);
    if (!groups.has(key)) groups.set(key, { agent: entry.agent, resource: entry.resource, ops: [...entry.ops].sort(), entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()].map((g) => {
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, g.entries.filter((e) => e.outcome === o).length]));
    const statistics = honestStatistics(g.entries.map((e) => STATUS[e.outcome]), { minimumSample, level });
    const points = g.entries.filter((e) => typeof e.confidence === 'number').map((e) => ({
      decisionId: e.id, agentId: g.agent, domain: `${g.resource}:${g.ops.join('+')}`, probability: e.confidence, status: STATUS[e.outcome]
    }));
    const calibration = points.length ? calibratePredictions(points, { minimumSample, level, buckets: 5 })[0] : null;
    /* Le niveau en vigueur : celui de la proposition la plus récente. */
    const recent = [...g.entries].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0];
    const current = recent.level;
    const failures = counts.declined + counts.undone;
    let suggestion = null;
    if (current === 'validation' && statistics.status === 'observed' && counts.undone === 0 && statistics.interval && statistics.interval.low >= loosenAbove) {
      suggestion = { action: 'loosen', from: 'validation', to: 'free_with_notice', reasons: ['high_success_rate', 'no_undo'] };
    } else if ((current === 'free' || current === 'free_with_notice') && counts.undone >= tightenUndone && statistics.sampleSize > 0 && failures / statistics.sampleSize >= tightenRate) {
      suggestion = { action: 'tighten', from: current, to: 'validation', reasons: ['undone_actions'] };
    }
    return {
      agent: g.agent, resource: g.resource, ops: g.ops, level: current, counts,
      sampleSize: statistics.sampleSize, rate: statistics.rate, interval: statistics.interval, status: statistics.status,
      calibration: calibration && { sampleSize: calibration.sampleSize, brierScore: calibration.brierScore, confidenceGap: calibration.confidenceGap,
        overconfidence: calibration.overconfidence, underconfidence: calibration.underconfidence, status: calibration.status },
      suggestion: suggestion && { ...suggestion, rule: { id: `confiance-${slug(g.agent)}-${slug(g.resource)}`, level: suggestion.to,
        match: { agents: [g.agent], resources: [g.resource], ops: g.ops } } }
    };
  }).sort((a, b) => (b.suggestion ? 1 : 0) - (a.suggestion ? 1 : 0) || b.sampleSize - a.sampleSize);
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

/** L'issue d'une proposition gardée par le pack (magasin des propositions). */
function outcomeOfRecord(record) {
  if (record.status === 'undone') return 'undone';
  if (record.status === 'declined') return 'declined';
  const approved = record.validation?.decision === 'approve';
  if (approved) return 'approved';
  if (record.status === 'executed' || record.status === 'undoing') return 'unreviewed';
  return 'unknown';
}

/** Les entrées de trustSuggestions tirées des propositions du pack (une par ressource touchée). */
function trustEntriesFromRecords(records) {
  return records.flatMap((record) => {
    const p = record.proposal;
    if (!p?.classification?.groups) return [];
    return p.classification.groups.map((g) => ({
      id: record.id, agent: p.agent.id, resource: g.resource, ops: g.ops, level: record.level,
      confidence: p.intent?.confidence ?? null, outcome: outcomeOfRecord(record), at: p.createdAt
    }));
  });
}

module.exports = { trustSuggestions, trustEntriesFromRecords, outcomeOfRecord, TRUST_OUTCOMES: OUTCOMES };
