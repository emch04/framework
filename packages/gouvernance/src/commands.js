'use strict';
const { GouvernanceError } = require('./errors');
const { defineResources, isPlainObject } = require('./contract');

/*
 * Connecteur de commandes : pour les actions qui ne se résument pas à des lignes d'une base (envoyer
 * un e-mail, déclencher un traitement). Une commande se propose comme un ajout : ses valeurs sont
 * l'aperçu exact que la personne valide, et rien ne part avant l'exécution.
 * Un effet sur le monde ne se défait pas et ne se regroupe pas : une seule commande par proposition,
 * jamais d'annulation, jamais « libre avec avis ».
 */

const fail = (code, message) => { throw new GouvernanceError(code, message); };

function createCommandConnector({ commands } = {}) {
  if (!isPlainObject(commands) || !Object.keys(commands).length) fail('invalid_resources', 'Déclarer au moins une commande.');
  const declaration = {};
  for (const [name, command] of Object.entries(commands)) {
    if (!isPlainObject(command) || typeof command.run !== 'function') fail('invalid_resources', `${name} : la commande doit avoir run().`);
    if (command.recheck !== undefined && typeof command.recheck !== 'function') fail('invalid_resources', `${name} : recheck doit être une fonction.`);
    declaration[name] = {
      table: name, key: 'id', writable: command.fields, sensitive: command.sensitive, tags: command.tags,
      amount: command.amount, maxRows: 1, operations: ['insert']
    };
  }
  const resources = defineResources(declaration);
  return {
    kind: 'commands',
    resources,
    singleAction: true,
    undoable: false,
    /* Une commande n'existe pas encore : l'aperçu vient de ses valeurs. */
    async preview() { return { rows: [] }; },
    async execute(plan, { finalize }) {
      const [step] = plan.steps;
      const [write] = step.writes;
      if (plan.steps.length !== 1 || step.writes.length !== 1 || write.kind !== 'insert') fail('invalid_action', 'Une commande à la fois, sans annulation.');
      const command = commands[step.resource];
      /* Revérifier au dernier moment : un destinataire ou un état a pu changer depuis la validation. */
      const reason = command.recheck ? await command.recheck(write.values) : null;
      if (reason) return { ok: false, code: 'stale_data', detail: { action: step.action, reason: String(reason) } };
      /* L'état « en cours » déjà pris empêche tout second lancement. `idempotencyKey` protège en plus chez le destinataire. */
      const answer = await command.run(write.values, { idempotencyKey: write.values.id });
      const rowsAffected = Number.isSafeInteger(answer?.count) && answer.count >= 0 ? answer.count : 1;
      await finalize({ rowsAffected, client: null });
      return { ok: true, rowsAffected };
    }
  };
}

module.exports = { createCommandConnector };
