'use strict';

const faker = require('@faker-js/faker');

/**
 * Données par pays. Les noms et adresses viennent des locales de faker quand
 * elles existent (fr, fr_BE, fr_CH, fr_CA, fr_SN, en_US, en_GB, en_GH, en_NG,
 * en_ZA, en_IN, es, es_MX, pt_PT, pt_BR, de, it, ja, ko). faker n'a pas de
 * locale pour la RDC : listes de prénoms, noms et villes écrites ici. Les
 * téléphones suivent partout le plan de numérotation national : `#` = chiffre,
 * `N` = chiffre de 2 à 9, un chiffre = lui-même, `(a|b|c)` = un choix.
 */
const COUNTRIES = {
  CD: {
    name: 'République démocratique du Congo',
    locales: ['fr'],
    phone: ['+243 (81|82|83|84|85|89|97|98|99) ### ####'],
    postalCode: null,
    firstNames: {
      female: ['Grace', 'Esther', 'Christelle', 'Merveille', 'Prisca', 'Ruth', 'Fabiola', 'Nathalie', 'Sarah', 'Dorcas', 'Médiatrice', 'Blandine'],
      male: ['Patrick', 'Jean-Claude', 'Emmanuel', 'Dieudonné', 'Trésor', 'Christian', 'Héritier', 'Joël', 'Gédéon', 'Fiston', 'Rodrigue', 'Papy']
    },
    lastNames: ['Mukendi', 'Kasongo', 'Ilunga', 'Mwamba', 'Tshibangu', 'Kalala', 'Ngoy', 'Mbuyi', 'Banza', 'Kabeya', 'Kitenge', 'Lukusa', 'Mutombo', 'Nsimba', 'Kimbembe', 'Bakambu'],
    cities: ['Kinshasa', 'Lubumbashi', 'Goma', 'Mbuji-Mayi', 'Kisangani', 'Bukavu', 'Kananga', 'Likasi', 'Kolwezi', 'Matadi'],
    regions: ['Kinshasa', 'Haut-Katanga', 'Nord-Kivu', 'Kasaï-Oriental', 'Tshopo', 'Sud-Kivu', 'Kasaï-Central', 'Kongo-Central'],
    streets: ['Avenue de la Libération', 'Avenue Kasa-Vubu', 'Boulevard du 30 Juin', 'Avenue de la Paix', 'Avenue Kabinda', 'Avenue de l\'Enseignement', 'Avenue du Commerce'],
    districts: ['Gombe', 'Limete', 'Ngaliema', 'Lemba', 'Kintambo', 'Matete', 'Bandalungwa']
  },
  FR: { name: 'France', locales: ['fr'], phone: ['+33 (6|7) ## ## ## ##'] },
  BE: { name: 'Belgique', locales: ['fr_BE', 'fr'], phone: ['+32 4## ## ## ##'] },
  CH: { name: 'Suisse', locales: ['fr_CH', 'fr'], phone: ['+41 7# ### ## ##'] },
  CA: { name: 'Canada', locales: ['fr_CA', 'fr'], phone: ['+1 (514|438|418|613|416) ### ####'] },
  SN: { name: 'Sénégal', locales: ['fr_SN', 'fr'], phone: ['+221 7# ### ## ##'] },
  US: { name: 'United States', locales: ['en_US'], phone: ['+1 N## N## ####'] },
  GB: { name: 'United Kingdom', locales: ['en_GB'], phone: ['+44 7### ######'] },
  GH: { name: 'Ghana', locales: ['en_GH'], phone: ['+233 (20|24|26|54|55) ### ####'] },
  NG: { name: 'Nigeria', locales: ['en_NG'], phone: ['+234 (802|803|805|810|813) ### ####'] },
  ZA: { name: 'South Africa', locales: ['en_ZA'], phone: ['+27 (82|83|72|76) ### ####'] },
  IN: { name: 'India', locales: ['en_IN'], phone: ['+91 (9|8|7)#### #####'] },
  ES: { name: 'España', locales: ['es'], phone: ['+34 (6|7)## ## ## ##'] },
  MX: { name: 'México', locales: ['es_MX', 'es'], phone: ['+52 55 #### ####'] },
  PT: { name: 'Portugal', locales: ['pt_PT'], phone: ['+351 9# ### ####'] },
  BR: { name: 'Brasil', locales: ['pt_BR'], phone: ['+55 (11|21|31) 9####-####'] },
  DE: { name: 'Deutschland', locales: ['de'], phone: ['+49 15## #######'] },
  IT: { name: 'Italia', locales: ['it'], phone: ['+39 3## ### ####'] },
  JP: { name: '日本', locales: ['ja'], phone: ['+81 90-####-####'] },
  KR: { name: '대한민국', locales: ['ko'], phone: ['+82 10-####-####'] }
};

function localesFor(code) {
  const config = COUNTRIES[code];
  // La liste se termine par l'anglais puis la base : faker retombe dessus quand une donnée manque.
  return [...config.locales.map((name) => faker[name]), faker.en, faker.base];
}

module.exports = { COUNTRIES, localesFor };
