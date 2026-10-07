/**
 * `@astratra/centrale/ia` : chronométrer un appel à un modèle d'IA et l'envoyer,
 * sans jamais le contenu des messages (seuls fournisseur, modèle, durée, jetons, résultat).
 */

import type { EvenementIA } from './envoi.ts';
import { centraleParDefaut } from './coeur.ts';
import type { Centrale } from './coeur.ts';

export interface Jetons {
  entree?: number;
  sortie?: number;
  cache?: number;
}

export interface InfosAppelIA<R> {
  fournisseur: string;
  modele: string;
  outil?: string;
  /** Instance à utiliser ; par défaut celle du dernier `demarrer()`. */
  centrale?: Centrale;
  /** Lit les jetons dans le résultat (par exemple `r.usage`). */
  jetons?: (resultat: R) => Jetons | undefined;
  /** Dit si le résultat vient d'un modèle de repli. */
  estRepli?: (resultat: R) => boolean;
}

/** Vrai si l'erreur ressemble à un dépassement de quota ou de débit. */
export function estErreurQuota(erreur: unknown): boolean {
  if (!erreur || typeof erreur !== 'object') return false;
  const e = erreur as { status?: unknown; statusCode?: unknown; statut?: unknown; code?: unknown; message?: unknown };
  const statut = Number(e.status ?? e.statusCode ?? e.statut);
  if (statut === 429) return true;
  const texte = `${String(e.code ?? '')} ${String(e.message ?? '')}`;
  return /quota|rate.?limit|too many requests|resource.?exhausted|insufficient_quota/i.test(texte);
}

const maintenant = (): number =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

/**
 * Exécute `fn`, mesure sa durée et envoie un événement `ia`. Le résultat et les erreurs
 * de `fn` sont rendus tels quels : la mesure elle-même ne lève jamais.
 */
export async function mesurerAppelIA<R>(infos: InfosAppelIA<R>, fn: () => Promise<R> | R): Promise<R> {
  const debut = maintenant();
  const envoyer = (resultat: EvenementIA['resultat'], jetons?: Jetons) => {
    try {
      const centrale = infos.centrale ?? centraleParDefaut();
      centrale?.ia({
        fournisseur: infos.fournisseur,
        modele: infos.modele,
        outil: infos.outil,
        dureeMs: maintenant() - debut,
        resultat,
        jetonsEntree: jetons?.entree,
        jetonsSortie: jetons?.sortie,
        jetonsCache: jetons?.cache
      });
    } catch { /* jamais chez l'appelant */ }
  };
  let resultat: R;
  try {
    resultat = await fn();
  } catch (erreur) {
    envoyer(estErreurQuota(erreur) ? 'quota' : 'erreur');
    throw erreur;
  }
  let jetons: Jetons | undefined;
  let repli = false;
  try { jetons = infos.jetons?.(resultat); } catch { /* lecteur fautif : sans jetons */ }
  try { repli = infos.estRepli?.(resultat) === true; } catch { /* idem */ }
  envoyer(repli ? 'repli' : 'ok', jetons);
  return resultat;
}
