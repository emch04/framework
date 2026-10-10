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

## Ce qui est suivi par `suivreApplication()`

- **Sessions** : début au lancement et au retour après 30 s, fin en arrière-plan prolongé ou à la fermeture ; une session restée ouverte devient « plantage » ou « anormale » au lancement suivant.
- **Plantages** : exceptions Objective-C, signaux fatals (erreur Swift, accès mémoire, abandon) et rapports de plantage d'Apple (MetricKit) avec la pile du fil fautif.
- **Fermetures sans plantage** : le dernier état de l'app est gardé sur le disque au fil de l'eau (les 50 dernières actions, la mémoire occupée, un blocage en cours). Au lancement suivant, une fermeture au premier plan (`FermetureInattendue`) ou pendant un blocage (`FermeturePendantBlocage`) part avec ce fil d'Ariane, l'écran, la mémoire au moment et la plus haute du lancement.
- **App bloquée** : un gardien vérifie le fil principal toutes les 0,5 s ; une interface sans réponse plus de 2 s est signalée (`AppBloquee`, erreur au-delà de 5 s) avec sa durée.
- **Appareil** : mémoire saturée (`MemoireSaturee`, au plus une fois par minute), surchauffe critique (`Surchauffe`), et dans le fil d'Ariane la température, l'économie d'énergie, le premier plan et l'arrière-plan.
- **Rapports d'Apple** (MetricKit, livrés par le système) : blocages, excès de processeur ou d'écriture disque, lancements lents (iOS), avec la pile ; chaque jour, les fermetures comptées par raison (`rapport_apple`, et `FermeturesSysteme` quand le système a forcé la fermeture : mémoire, chien de garde, accès mémoire…).
- Chaque erreur porte la mémoire occupée (`memoire_mo`) ; chaque écran entre dans le fil d'Ariane.
- Hors mode strict, le contexte décrit l'appareil (`Appareil.decrire()` : modèle et mémoire, « iPhone17,2 · 8 Go »).

## Ce qui ne part jamais

Le contenu des messages envoyés à une IA, le texte saisi, les identifiants réels dans les noms d'écran, le modèle d'appareil et l'utilisateur (en mode strict). L'appel d'IA n'a que des champs fixes : fournisseur, modèle, durée, jetons, résultat, outil.

## Limites

- La pile d'un blocage n'est connue que par le rapport d'Apple (le gardien ne lit pas le fil principal).
- Une app tuée en arrière-plan par le système (normal sur iPhone) n'est signalée que si un blocage était en cours.
- Les noms de fonctions des piles ne sont pas symbolisés.

## Tests

```sh
swift test
```

Faux transport, jamais de réseau. `CENTRALE_ECHANTILLON=/chemin swift test` écrit chaque corps envoyé, pour le vérifier contre la validation du backend.
