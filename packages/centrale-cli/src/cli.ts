#!/usr/bin/env node
/**
 * `centrale` : l'outil en ligne de commande de Centrale LJ.
 *   centrale injecter <dossier>
 *   centrale envoyer-cartes <dossier> --version X
 *   centrale deploiement --version X --commit SHA [--depot owner/repo] [--environnement production]
 * Le jeton de déploiement se lit dans CENTRALE_JETON, l'adresse du backend dans CENTRALE_ADRESSE.
 * Code de sortie : 0 si tout va bien, 1 en cas d'échec, 2 pour une commande mal formée.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cheminRelatif, injecterDossier } from './injecter.ts';
import { declarerDeploiement, envoyerCartes, type Connexion } from './envoyer.ts';

const AIDE = `Utilisation :
  centrale injecter <dossier>
      Ajoute un identifiant de débogage à chaque fichier JS du build et à sa carte (.map).
  centrale envoyer-cartes <dossier> --version X
      Envoie les cartes (.map) au backend ; celles qu'il a déjà sont sautées.
  centrale deploiement --version X --commit SHA [--depot owner/repo] [--environnement production]
      Déclare un déploiement (pour la version d'apparition et le commit suspect).

Variables d'environnement : CENTRALE_JETON (jeton de déploiement clj_dep_…), CENTRALE_ADRESSE (adresse du backend).`;

interface Sorties { ecrire: (texte: string) => void; erreur: (texte: string) => void }
interface Options { env?: NodeJS.ProcessEnv; sorties?: Sorties; connexion?: Partial<Connexion> }

/** Sépare les arguments positionnels et les options `--nom valeur` / `--nom=valeur`. */
export function lireArguments(args: string[]): { positionnels: string[]; options: Record<string, string> } {
  const positionnels: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const egal = a.indexOf('=');
      if (egal !== -1) options[a.slice(2, egal)] = a.slice(egal + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) options[a.slice(2)] = args[++i];
      else options[a.slice(2)] = 'true';
    } else {
      positionnels.push(a);
    }
  }
  return { positionnels, options };
}

function connexionDe(env: NodeJS.ProcessEnv, sorties: Sorties, surcharge: Partial<Connexion> = {}): Connexion | null {
  const jeton = env.CENTRALE_JETON?.trim();
  const adresse = env.CENTRALE_ADRESSE?.trim();
  if (!jeton || !/^clj_dep_/.test(jeton)) { sorties.erreur('CENTRALE_JETON manque ou n\'est pas un jeton de déploiement (clj_dep_…).'); return null; }
  if (!adresse || !/^https?:\/\//.test(adresse)) { sorties.erreur('CENTRALE_ADRESSE manque (par exemple https://centrale.exemple.fr).'); return null; }
  return { adresse, jeton, ...surcharge };
}

function dossierValide(chemin: string | undefined, sorties: Sorties): string | null {
  if (!chemin) { sorties.erreur('Dossier manquant.'); return null; }
  const absolu = resolve(chemin);
  if (!existsSync(absolu) || !statSync(absolu).isDirectory()) { sorties.erreur(`Dossier introuvable : ${chemin}`); return null; }
  return absolu;
}

/** Exécute une commande ; rend le code de sortie. Ne lève pas. */
export async function executer(args: string[], { env = process.env, sorties = { ecrire: console.log, erreur: console.error }, connexion: surcharge }: Options = {}): Promise<number> {
  const [commande, ...reste] = args;
  const { positionnels, options } = lireArguments(reste);
  try {
    switch (commande) {
      case 'injecter': {
        const dossier = dossierValide(positionnels[0], sorties);
        if (!dossier) return 2;
        const resultats = injecterDossier(dossier);
        const compte = { injecte: 0, deja: 0, 'carte-seule': 0, 'sans-carte': 0 };
        for (const r of resultats) {
          compte[r.etat]++;
          if (r.etat !== 'sans-carte') sorties.ecrire(`${r.etat === 'deja' ? '=' : '+'} ${cheminRelatif(dossier, r.fichier)}  ${r.debugId}`);
        }
        sorties.ecrire(`${compte.injecte} injecté(s), ${compte.deja} déjà fait(s), ${compte['carte-seule']} carte(s) seule(s), ${compte['sans-carte']} fichier(s) JS sans carte.`);
        return 0;
      }
      case 'envoyer-cartes': {
        const dossier = dossierValide(positionnels[0], sorties);
        if (!dossier) return 2;
        if (!options.version || options.version === 'true') { sorties.erreur('--version est obligatoire.'); return 2; }
        const connexion = connexionDe(env, sorties, surcharge);
        if (!connexion) return 2;
        const bilan = await envoyerCartes(connexion, { dossier, version: options.version, signaler: (m) => sorties.ecrire(`… ${m}`) });
        for (const f of bilan.tropGrosses) sorties.erreur(`Carte trop grosse, non envoyée : ${f}`);
        for (const r of bilan.refusees) sorties.erreur(`Carte refusée (${r.debugId}) : ${r.raison}`);
        sorties.ecrire(`${bilan.envoyees.length} carte(s) envoyée(s), ${bilan.dejaConnues.length} déjà connue(s).`);
        return bilan.refusees.length || bilan.tropGrosses.length ? 1 : 0;
      }
      case 'deploiement': {
        if (!options.version || options.version === 'true' || !options.commit || options.commit === 'true') { sorties.erreur('--version et --commit sont obligatoires.'); return 2; }
        const connexion = connexionDe(env, sorties, surcharge);
        if (!connexion) return 2;
        await declarerDeploiement(connexion, {
          version: options.version,
          commit: options.commit,
          ...(options.depot ? { depot: options.depot } : {}),
          ...(options.environnement ? { environnement: options.environnement } : {})
        });
        sorties.ecrire(`Déploiement ${options.version} (${options.commit.slice(0, 12)}) déclaré.`);
        return 0;
      }
      case undefined:
      case 'aide':
      case '--help':
      case '-h':
        sorties.ecrire(AIDE);
        return commande === undefined ? 2 : 0;
      default:
        sorties.erreur(`Commande inconnue : ${commande}\n\n${AIDE}`);
        return 2;
    }
  } catch (erreur) {
    sorties.erreur(`Échec : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    return 1;
  }
}

/* Lancé directement (bin `centrale`) : on exécute avec les arguments du processus. */
function lanceDirectement(): boolean {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (lanceDirectement()) {
  process.exitCode = await executer(process.argv.slice(2));
}
