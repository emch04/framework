# Modèles de garde : quels modèles ouverts, et pourquoi

`@astratra/models` sert deux modèles de protection à côté des cinq existants.

| Point d'entrée | Modèle | Licence | Taille sur disque | Langues |
|---|---|---|---|---|
| `POST /injection` | [Horizon-Labs/prompt-injection-guard-small](https://huggingface.co/Horizon-Labs/prompt-injection-guard-small) | Apache-2.0 | 256 Mo (ONNX int8) + 33 Mo de tokenizer | entraîné sur 30 langues, français et anglais évalués |
| `POST /moderation` | [Horizon-Labs/content-safety-guard-small](https://huggingface.co/Horizon-Labs/content-safety-guard-small) | Apache-2.0 | 256 Mo (ONNX int8) + 33 Mo de tokenizer | 24 langues, français et anglais évalués |

Deux encodeurs de 141 millions de paramètres (mmBERT-small, MIT) qui tournent
sur le processeur avec `onnxruntime` : ni GPU ni torch. Rien n'est entraîné
ici ; les poids sont téléchargés par `astratra-models fetch`, à la révision et
au SHA-256 figés dans `data/models-manifest.json`, et ne sont jamais dans le
paquet npm.

## Ce que nous avons vérifié nous-mêmes

Les deux modèles ont été téléchargés et passés dans le service avec des textes
français et anglais (cas `RealGuardModelsTest` de `server/tests/test_real_models.py`,
ignorés quand les poids manquent) :

- injection : les consignes classiques (« ignore all previous instructions »,
  « ignorez toutes les instructions précédentes »), une consigne plantée dans
  une page web ou un courriel pour l'assistant, un jailbreak par personnage et
  une consigne cachée à la fin d'un long document dépassent 0,99 ; une
  demande de recette, une facture, un résultat de recherche et « ignore mon
  précédent courriel, la réunion est reportée » restent sous 0,05 ;
- modération : menaces, harcèlement, haine, automutilation et contenu sexuel
  explicite sont signalés dans les deux langues avec la bonne catégorie ;
  le français ordinaire (« comment tuer un processus », « un match violent »)
  ne l'est pas. Une demande d'histoire explicite avec une fille de 12 ans est
  signalée `sexual_minors`.

## Candidats examinés

Voir le tableau détaillé (anglais) dans [guard-models.md](guard-models.md) :
licence, taille, langues, décision pour chacun. En résumé :

- **Injection** : retenu `Horizon-Labs/prompt-injection-guard-small` (Apache-2.0,
  multilingue, entraîné sur l'injection indirecte). Écartés : ProtectAI v2
  (anglais seul, beaucoup de fausses alertes), Llama Prompt Guard 2 (licence
  Llama 4, accès soumis à approbation), Qualifire (licence « other », accès
  conditionné), Wolf Defender (allemand et anglais), proventra mDeBERTa
  (1,1 Go sans ONNX, aucune évaluation), Rogue Security (« other »), TestSavant
  (aucune licence).
- **Modération** : retenu `Horizon-Labs/content-safety-guard-small`
  (Apache-2.0, 24 langues, un score par catégorie dont les six demandées).
  Écartés : Qwen3Guard-Gen-0.6B (génératif, 1,5 Go, pas de score par
  catégorie), unitary/multilingual-toxic-xlm-roberta (toxicité seulement,
  poids au format pickle), les classeurs de toxicité OpenRAIL++, KoalaAI
  (anglais, OpenRAIL), Aegis/Llama Guard/ShieldGemma (licences propres, plusieurs
  Go).

## Limites à connaître

- **`sexual_minors` est faible** (F1 0,39 sur le jeu de test de l'éditeur) :
  ne vous y fiez pas seul pour la protection des mineurs ou la conformité
  légale ; c'est un signal parmi d'autres, avec relecture humaine.
- `violence` et `harassment` sont moyennes (F1 0,56 et 0,52) ; le modèle
  bloque environ un cinquième des demandes « sûres mais inquiétantes » du jeu
  XSTest : réglez `MODELS_MODERATION_THRESHOLDS` sur votre trafic.
- Les catégories ne veulent rien dire pour un texte non signalé dans son
  ensemble ; le service n'en rapporte aucune dans ce cas.
- Le modèle d'injection lit un texte isolé ; il ne sait pas si une consigne
  est légitime dans son contexte. Son rappel publié sur BIPIA est de 0,53 au
  seuil par défaut : une garde abaisse le seuil avant une action et exige de
  toute façon un humain.
- L'éditeur est récent et les modèles peu téléchargés. La parade est
  l'épinglage : une révision et un SHA-256 par fichier, vérifiés au
  téléchargement et au démarrage. Relisez `data/models-manifest.json` avant
  de déplacer un épinglage.

## Licences et mentions

Rien n'est redistribué : l'utilisateur télécharge les poids depuis Hugging
Face, sous leur propre licence, qui autorise l'usage commercial. Les mentions
sont dans [data/MODELS-NOTICE](../data/MODELS-NOTICE).
