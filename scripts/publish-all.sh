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
#   bash scripts/publish-all.sh            # npm demandera le code à chaque fois
#   bash scripts/publish-all.sh --dry-run  # montre ce qui partirait
#
# Avec un jeton d'automatisation dans ~/.npmrc, aucun code n'est demandé.
set -uo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

ORDER=(
  "@astratra/core"
  "@astratra/security"
  "@astratra/ai"
  "@astratra/credentials"
  "@astratra/entitlements"
  "@astratra/notify"
  "@astratra/client"
  "@astratra/payments"
  "@astratra/privacy"
  "@astratra/resilience"
  "@astratra/i18n-server"
  "@astratra/pdf"
  "@astratra/closure"
  "@astratra/prerender"
  "@astratra/react"
  "@astratra/tooling"
  "@astratra/saas-kit"
  "@astratra/saas-kit-ui"
  "@astratra/store-mongo"
  "@astratra/store-postgres"
  "create-astratra-app"
)

published=(); skipped=(); failed=()

for name in "${ORDER[@]}"; do
  dir="packages/${name#@astratra/}"
  [ -f "$dir/package.json" ] || { echo "  ?      $name — dossier introuvable"; continue; }

  local_v=$(node -p "require('./$dir/package.json').version")
  pub_v=$(npm view "$name" version 2>/dev/null || true)

  if [ "$local_v" = "$pub_v" ]; then
    printf "  =      %-28s %s\n" "$name" "$local_v"
    skipped+=("$name")
    continue
  fi

  printf "  →      %-28s %s → %s\n" "$name" "${pub_v:-absent}" "$local_v"
  [ "$DRY" = "1" ] && continue

  if npm publish --workspace "$name" --access public >/dev/null 2>&1; then
    printf "         publié\n"
    published+=("$name")
  else
    printf "         ÉCHEC — relance le script, il reprendra ici\n"
    failed+=("$name")
  fi
done

echo
echo "publiés : ${#published[@]} | déjà à jour : ${#skipped[@]} | échecs : ${#failed[@]}"
[ ${#failed[@]} -gt 0 ] && { printf '  échec : %s\n' "${failed[@]}"; exit 1; }
exit 0
