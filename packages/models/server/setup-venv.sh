#!/usr/bin/env bash
# Create (or update) the Python virtual environment of the model service with
# the exact versions pinned in the requirements files next to this script.
#
#   setup-venv.sh [--python python3] [--components onnx,entities,transcribe|all] [--check-only] VENV_DIR
#
#   onnx        embed, rerank, nli          (onnxruntime + tokenizers, no torch)
#   entities    entities (GLiNER)           (torch CPU wheel, transformers)
#   transcribe  transcribe (faster-whisper) (ctranslate2, av)
#
# Refuses any requirement that is not pinned with "==", and any package pinned
# to two different versions across the selected files. After installing, it
# checks that what pip installed matches the pins. --check-only validates the
# pins and exits without creating anything (no network).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python_bin="python3"
components="all"
check_only=0
venv_dir=""
torch_index="https://download.pytorch.org/whl/cpu"

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --python) python_bin="${2:?--python needs a value}"; shift 2 ;;
    --components) components="${2:?--components needs a value}"; shift 2 ;;
    --check-only) check_only=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 64 ;;
    *) venv_dir="$1"; shift ;;
  esac
done

if [ "$components" = "all" ]; then
  components="onnx,entities,transcribe"
fi

files=()
needs_torch=0
IFS=',' read -r -a wanted <<< "$components"
for component in "${wanted[@]}"; do
  case "$component" in
    onnx|transcribe) files+=("$here/requirements-$component.txt") ;;
    entities) files+=("$here/requirements-entities.txt"); needs_torch=1 ;;
    *) echo "unknown component: $component (onnx, entities, transcribe or all)" >&2; exit 64 ;;
  esac
done

# Every line is a comment, blank, or name==version. One version per package.
# Kept as "name==version" lines (no associative arrays: macOS ships bash 3.2).
pins=""
for file in "${files[@]}"; do
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -z "$line" ] && continue
    if ! [[ "$line" =~ ^[A-Za-z0-9._-]+==[A-Za-z0-9.+!_-]+$ ]]; then
      echo "not pinned with ==: $line ($(basename "$file"))" >&2
      exit 65
    fi
    name="$(printf '%s' "${line%%==*}" | tr '[:upper:]_.' '[:lower:]--')"
    version="${line#*==}"
    previous="$(printf '%s\n' "$pins" | grep -E "^${name}==" | head -n 1 || true)"
    if [ -n "$previous" ] && [ "${previous#*==}" != "$version" ]; then
      echo "conflicting pins for $name: ${previous#*==} and $version" >&2
      exit 65
    fi
    if [ -z "$previous" ]; then
      pins="${pins}${name}==${version}"$'\n'
    fi
  done < "$file"
done
count="$(printf '%s' "$pins" | grep -c '==' || true)"

echo "pins ok: ${count} packages for components: $components"
if [ "$check_only" -eq 1 ]; then
  exit 0
fi

if [ -z "$venv_dir" ]; then
  echo "missing VENV_DIR" >&2
  usage >&2
  exit 64
fi

if [ ! -x "$venv_dir/bin/python" ]; then
  "$python_bin" -m venv "$venv_dir"
fi
pip=("$venv_dir/bin/python" -m pip --disable-pip-version-check --no-input)

args=()
for file in "${files[@]}"; do
  args+=(-r "$file")
done
if [ "$needs_torch" -eq 1 ]; then
  # CPU wheel of torch: the default index resolves to CUDA builds on Linux.
  args+=(--extra-index-url "$torch_index")
fi
"${pip[@]}" install "${args[@]}"
"${pip[@]}" check

# What pip installed must be what the files pin (names normalised by
# importlib.metadata; torch CPU wheels carry a "+cpu" local suffix).
printf '%s' "$pins" | "$venv_dir/bin/python" -c '
import sys
from importlib.metadata import PackageNotFoundError, version
bad = 0
for line in sys.stdin.read().split():
    name, want = line.split("==", 1)
    try:
        got = version(name)
    except PackageNotFoundError:
        got = "none"
    if got.split("+", 1)[0] != want:
        print(f"version mismatch for {name}: pinned {want}, installed {got}", file=sys.stderr)
        bad = 1
sys.exit(bad)
'
echo "venv ready: $venv_dir"
