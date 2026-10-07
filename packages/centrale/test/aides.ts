/** Outils communs aux tests : un transport factice qui garde les requêtes et rejoue des réponses. */

import type { Envoi } from '../src/envoi.ts';
import type { ConfigCentrale } from '../src/coeur.ts';
import type { ReponseTransport, RequeteTransport, Transport } from '../src/transport.ts';

export interface TransportFactice {
  transport: Transport;
  requetes: RequeteTransport[];
  envois: () => Envoi[];
  /** Réponses à rendre dans l'ordre ; ensuite 202. Une fonction peut lever. */
  reponses: Array<ReponseTransport | (() => ReponseTransport)>;
}

export function transportFactice(): TransportFactice {
  const requetes: RequeteTransport[] = [];
  const reponses: TransportFactice['reponses'] = [];
  return {
    requetes,
    reponses,
    envois: () => requetes.map((r) => JSON.parse(r.corps) as Envoi),
    transport: async (requete) => {
      requetes.push(requete);
      const suivante = reponses.shift();
      if (typeof suivante === 'function') return suivante();
      return suivante ?? { statut: 202 };
    }
  };
}

export const CONFIG: ConfigCentrale = {
  cle: 'clj_pub_test1234567890',
  adresse: 'https://centrale.exemple.fr/',
  environnement: 'developpement',
  version: '1.2.3',
  sel: 'sel-du-projet'
};

/** Une horloge réglable à la main. */
export function horloge(depart = Date.UTC(2026, 9, 7, 12, 0, 0)) {
  let t = depart;
  return { maintenant: () => t, avancer: (ms: number) => { t += ms; } };
}
