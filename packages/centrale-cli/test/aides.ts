/** Outils communs aux tests du CLI. */
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { lireVlq } from '../src/vlq.ts';

export const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

/** Une copie des fixtures dans un dossier temporaire (les tests y écrivent). */
export function copieDesFixtures(): string {
  // Chemin réel (macOS : /var est un lien vers /private/var), comme dans les piles d'appels.
  const dossier = realpathSync(mkdtempSync(join(tmpdir(), 'centrale-cli-')));
  cpSync(FIXTURES, dossier, { recursive: true });
  return dossier;
}

/** Les segments absolus [colonne générée, source, ligne, colonne] de chaque ligne générée. */
export function segments(mappings: string): number[][][] {
  const etat = [0, 0, 0, 0];
  return mappings.split(';').map((ligne) => {
    let colonne = 0;
    return ligne.split(',').filter(Boolean).map((seg) => {
      const valeurs: number[] = [];
      let i = 0;
      while (i < seg.length) { const [v, fin] = lireVlq(seg, i); valeurs.push(v); i = fin; }
      colonne += valeurs[0];
      if (valeurs.length >= 4) { etat[1] += valeurs[1]; etat[2] += valeurs[2]; etat[3] += valeurs[3]; }
      return [colonne, etat[1], etat[2], etat[3]];
    });
  });
}

/** La position d'origine (ligne et colonne à partir de 0) d'une position générée. */
export function origine(mappings: string, ligne: number, colonne: number): [number, number] | null {
  const ligneSegs = segments(mappings)[ligne] ?? [];
  let trouve: number[] | null = null;
  for (const s of ligneSegs) if (s[0] <= colonne) trouve = s;
  return trouve ? [trouve[2], trouve[3]] : null;
}

/** Un faux `fetch` qui garde les requêtes et rejoue des réponses (ensuite : la fonction par défaut). */
export function fetchFactice(parDefaut: (url: string, corps: unknown) => { statut: number; json?: unknown; entetes?: Record<string, string> }) {
  const requetes: Array<{ url: string; entetes: Record<string, string>; corps: unknown }> = [];
  const reponses: Array<{ statut: number; json?: unknown; entetes?: Record<string, string> } | Error> = [];
  const { gunzipSync } = zlib;
  const f = (async (url: string, init: RequestInit) => {
    const entetes = init.headers as Record<string, string>;
    const brut = init.body as string | Buffer;
    const texte = entetes['Content-Encoding'] === 'gzip' ? gunzipSync(brut as Buffer).toString('utf8') : String(brut);
    const corps = JSON.parse(texte);
    requetes.push({ url, entetes, corps });
    const suivante = reponses.shift() ?? parDefaut(url, corps);
    if (suivante instanceof Error) throw suivante;
    return new Response(suivante.json === undefined ? '' : JSON.stringify(suivante.json), { status: suivante.statut, headers: suivante.entetes });
  }) as unknown as typeof fetch;
  return { fetch: f, requetes, reponses };
}

