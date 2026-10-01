#!/usr/bin/env bash
#
# Publie les packages dont la version locale diffère de celle du registre.
#
# Rejouable sans danger : un package déjà en ligne à la bonne version est
# sauté, jamais republié — npm refuserait de toute façon, mais échouer sur
# quatorze paquets pour en publier deux rend le journal illisible.
#
# L'ordre suit les dépendances : core et security d'abord, puis ce qui s'appuie
# dessus. Un consommateur qui installe pendant la publication ne doit jamais
# tomber sur un package dont le voisin n'existe pas encore.
#
#   bash scripts/publish-all.sh            # npm demande de valider chaque paquet
#   bash scripts/publish-all.sh --dry-run  # montre ce qui partirait
#
# Avec un jeton d'AUTOMATISATION dans ~/.npmrc, aucun code n'est demandé — un
# jeton classique ne suffit pas, npm applique quand même la 2FA.
set -uo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

ORDER=(
  "@astratra/core"
  "@astratra/security"
  "@astratra/rag"
  "@astratra/credentials"
  "@astratra/entitlements"
  "@astratra/notify"
  "@astratra/client"
  "@astratra/native"
  "@astratra/native-ui"
  "@astratra/payments"
  "@astratra/privacy"
  "@astratra/resilience"
  "@astratra/ai"
  "@astratra/memory"
  "@astratra/models"
  "@astratra/i18n-server"
  "@astratra/pdf"
  "@astratra/loyalty"
  "@astratra/wallet"
  "@astratra/closure"
  "@astratra/app-version"
  "@astratra/app-guide"
  "@astratra/voice"
  "@astratra/live"
  "@astratra/prerender"
  "@astratra/react"
  "@astratra/tooling"
  "@astratra/saas-kit"
  "@astratra/saas-kit-ui"
  "@astratra/store-mongo"
  "@astratra/store-postgres"
  "@astratra/booking"
  "@astratra/collab"
  "@astratra/fhir"
  "@astratra/flags"
  "@astratra/ledger"
  "@astratra/repomap"
  "@astratra/srs"
  "@astratra/testkit"
  "create-astratra-app"
)

# Un paquet absent de la liste ne serait jamais publié, sans un mot : c'est
# arrivé aux quatre paquets du 19/09/2026. Tout dossier de packages/ doit y
# figurer, sinon rien ne part.
missing=()
for pj in packages/*/package.json; do
  name=$(node -p "require('./$pj').name")
  [[ " ${ORDER[*]} " == *" $name "* ]] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  printf '  absent de ORDER : %s\n' "${missing[@]}"
  echo "ajoute-les à leur place dans l'ordre des dépendances, puis relance."
  exit 1
fi

# Chaque dépendance interne (dependencies, peer, dev, optional) doit partir
# avant le paquet qui la réclame : sinon un projet installé pendant la
# publication demande une version encore absente du registre.
if ! node -e '
  const order = process.argv.slice(1);
  const kinds = ["dependencies", "peerDependencies", "devDependencies", "optionalDependencies"];
  let bad = 0;
  order.forEach((name, i) => {
    const pkg = require("./packages/" + name.replace(/^@astratra\//, "") + "/package.json");
    for (const kind of kinds) for (const dep of Object.keys(pkg[kind] || {})) {
      if (order.indexOf(dep) > i) { console.log("  " + name + " dépend de " + dep + ", placé après lui dans ORDER"); bad++; }
    }
  });
  process.exit(bad ? 1 : 0);
' "${ORDER[@]}"; then
  echo "remets ORDER dans l'ordre des dépendances, puis relance."
  exit 1
fi

published=(); skipped=(); staged=()

# La sortie de npm n'est pas capturée (voir plus bas) : la raison d'un échec se
# relit dans le journal que npm vient d'écrire.
npm_journal_dit() {
  # Pas de `npm config get logs-dir` : l'option est protégée, et l'appel
  # écrirait lui-même un journal plus récent que celui du refus.
  local motif="$1" paquet="${2/\//%2f}" dossier="${npm_config_logs_dir:-$HOME/.npm/_logs}"
  local journal
  journal=$(ls -t "$dossier"/*-debug-*.log 2>/dev/null | head -1)
  [ -n "$journal" ] && grep -q "$paquet" "$journal" && grep -qF "$motif" "$journal"
}

for name in "${ORDER[@]}"; do
  dir="packages/${name#@astratra/}"
  [ -f "$dir/package.json" ] || { echo "  ?      $name — dossier introuvable"; continue; }

  local_v=$(node -p "require('./$dir/package.json').version")
  # La version exacte, pas l'étiquette `latest` : juste après une publication,
  # le registre sert encore l'ancienne `latest` pendant quelques minutes.
  if [ -n "$(npm view "$name@$local_v" version 2>/dev/null || true)" ]; then
    printf "  =      %-28s %s\n" "$name" "$local_v"
    skipped+=("$name")
    continue
  fi

  pub_v=$(npm view "$name" version 2>/dev/null || true)
  printf "  →      %-28s %s → %s\n" "$name" "${pub_v:-absent}" "$local_v"
  [ "$DRY" = "1" ] && continue

  # npm écrit directement dans le terminal, sans capture : il y affiche le lien
  # de validation (« Authenticate your account at… ») ou demande le code 2FA,
  # puis attend la réponse. Capturée, cette sortie restait invisible et chaque
  # publication échouait sans que personne ait pu valider (21/09/2026).
  if npm publish --workspace "$name" --access public; then
    published+=("$name")
  elif npm_journal_dit "previously staged version \"$local_v\"" "$name"; then
    # E409 : npm a déjà accepté cette version et la garde « en attente »
    # quelques minutes (jusqu'à ~20) avant de la servir. Elle est publiée :
    # la suite peut partir, rien n'est à refaire (01/10/2026).
    echo "  …      $name $local_v déjà reçue par npm, encore en attente : comptée publiée"
    staged+=("$name")
  else
    # Arrêt au premier échec : la suite dépend de ce paquet, et la publier
    # quand même livre un paquet qui réclame une version absente. C'est arrivé
    # le 21/09/2026 : create-astratra-app 1.5.0 en ligne sans entitlements 0.5.0.
    echo
    echo "ÉCHEC : $name — la raison est affichée par npm juste au-dessus."
    echo "  E401 / ENEEDAUTH : \`npm login\`, puis relance."
    echo "  E403 « cannot publish over » : version déjà en ligne, relance dans quelques minutes."
    echo "  E409 « previously staged version » : npm a déjà reçu cette version et la traite ;"
    echo "    ne rien republier, attendre qu'elle apparaisse, puis relancer."
    echo "Relancer ne republie rien : les paquets déjà en ligne sont sautés."
    echo "publiés : ${#published[@]} | en attente chez npm : ${#staged[@]} | déjà à jour : ${#skipped[@]}"
    exit 1
  fi
done

echo
echo "publiés : ${#published[@]} | en attente chez npm : ${#staged[@]} | déjà à jour : ${#skipped[@]}"
[ ${#staged[@]} -gt 0 ] && echo "Les paquets en attente apparaissent d'eux-mêmes sous ~20 min (npm view <paquet>@<version>)."
exit 0
