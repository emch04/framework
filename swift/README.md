# AstratraCentrale (Swift)

Français

Le paquet de collecte en Swift d'un tableau de bord de surveillance auto-hébergé, pour les apps iOS et macOS : erreurs, plantages (exceptions Objective-C), écrans, usages, sessions et appels d'IA, masqués à la source puis envoyés par lots. **Même format d'envoi** que le paquet npm `@astratra/centrale` (version 1) : le même backend reçoit les deux.

- Aucune dépendance (Foundation seulement ; UIKit ou AppKit pour le suivi de l'app).
- **Ne lève jamais** chez l'appelant et ne bloque jamais l'app : les méthodes rendent la main tout de suite, l'envoi se fait en tâche de fond.
- **Sans clé ni adresse, tout est désactivé** : aucune minuterie, aucun appel réseau.
- **Mode strict par défaut** : ni utilisateur, ni modèle d'appareil.
- Masquage avant l'envoi (mêmes règles que `@astratra/centrale/masquage`) : jetons, clés, mots de passe, e-mails, IBAN, cartes bancaires, téléphones, noms fournis. Les écrans sont ramenés à leur gabarit (`/titre/:id`).
- iOS 17, macOS 14, Swift 6.

## Installation (Swift Package Manager)

Le `Package.swift` est à la racine du dépôt Astratra :

```swift
.package(url: "<adresse Git du dépôt Astratra>", revision: "<commit>")
// cible : .product(name: "AstratraCentrale", package: "<nom du dépôt>")
```

## Exemple minimal

```swift
import AstratraCentrale

let centrale = Centrale.demarrer(ConfigCentrale(
    cle: "clj_pub_…",                              // clé publique du projet (elle ne sert qu'à envoyer)
    adresse: "https://centrale.exemple.fr",
    environnement: .production,
    plateforme: .ios,                              // .bureau pour macOS
    version: "1.0.0",
    dossier: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent("centrale")        // garde une erreur fatale jusqu'au lancement suivant
))
centrale.suivreApplication()                       // sessions, arrière-plan, exceptions non attrapées

centrale.vue("/titre/42")                          // envoyé comme « /titre/:id »
centrale.erreur(erreur)                            // une Error Swift, avec la pile d'appels
centrale.ia(fournisseur: "gemini", modele: "gemini-3.8-flash", dureeMs: 812,
            jetonsEntree: 120, jetonsSortie: 45, resultat: .ok)
```

`Centrale.partagee` rend la dernière instance démarrée.

## Ce qui ne part jamais

Le contenu des messages envoyés à une IA, le texte saisi, les identifiants réels dans les noms d'écran, le modèle d'appareil et l'utilisateur (en mode strict). L'appel d'IA n'a que des champs fixes : fournisseur, modèle, durée, jetons, résultat, outil.

## Limites

- Les plantages Swift (`fatalError`, accès hors limites) ne passent pas par le gestionnaire d'exceptions : la session restée ouverte est signalée « anormale » au lancement suivant.
- Les noms de fonctions des piles ne sont pas symbolisés.

## Tests

```sh
swift test
```

Faux transport, jamais de réseau. `CENTRALE_ECHANTILLON=/chemin swift test` écrit chaque corps envoyé, pour le vérifier contre la validation du backend.
