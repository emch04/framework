const { ToolingError } = require('../errors');
const { shellQuote } = require('../shell');

const ACTION_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SCRIPT_PATH = /^\/[A-Za-z0-9._/-]+$/;
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: ([^\r\n]*))?$/;
const KEY_RESTRICTIONS = ['no-port-forwarding', 'no-pty', 'no-agent-forwarding', 'no-X11-forwarding'];

const DEFAULT_MESSAGES = {
  refused: 'Action refusee.',
  unknown: 'Action inconnue. Actions :',
  launched: 'Lance : {name}. Demande « {status} » pour suivre.',
  alreadyRunning: 'Deja en cours : {name}. Demande « {status} » pour suivre.',
  lockBusy: 'Verrou occupe : {name}.',
  noneYet: 'Aucune action lancee pour l\'instant.',
  running: 'en cours',
  finished: 'fini',
  done: 'Termine.',
  failed: 'Echec : voir le journal.',
  missingDir: 'Dossier introuvable :'
};

/** Mirror of the check the generated script makes, for tests and callers. */
function resolveDispatchAction(raw, actionNames) {
  const value = raw === undefined || raw === null ? '' : String(raw);
  if (!ACTION_NAME.test(value)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!actionNames.includes(value)) {
    return { ok: false, reason: 'unknown' };
  }
  return { ok: true, action: value };
}

/** `~/x` becomes "$HOME"/'x' in the script; anything else is quoted as is. */
function homeAware(value) {
  const text = String(value);
  if (text === '~') {
    return '"$HOME"';
  }
  if (text.startsWith('~/')) {
    return `"$HOME"/${shellQuote(text.slice(2))}`;
  }
  return shellQuote(text);
}

function assertPlainText(label, value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new ToolingError('DISPATCH_CONFIG_INVALID', `${label} : texte d'une ligne attendu.`, 400);
  }
}

function normalizeActions(config) {
  const statusAction = config.statusAction || 'status';
  if (!ACTION_NAME.test(statusAction)) {
    throw new ToolingError('DISPATCH_CONFIG_INVALID', `Nom d'action de suivi invalide : ${statusAction}`, 400);
  }
  if (!Array.isArray(config.actions) || config.actions.length === 0) {
    throw new ToolingError('DISPATCH_CONFIG_INVALID', 'dispatch.actions doit lister au moins une action.', 400);
  }

  const seen = new Set([statusAction]);
  const actions = config.actions.map((action) => {
    if (!action || !ACTION_NAME.test(String(action.name || ''))) {
      throw new ToolingError('DISPATCH_CONFIG_INVALID', `Nom d'action invalide : ${action && action.name} (a-z, 0-9, tiret).`, 400);
    }
    if (seen.has(action.name)) {
      throw new ToolingError('DISPATCH_CONFIG_INVALID', `Action en double : ${action.name}`, 400);
    }
    seen.add(action.name);
    assertPlainText(`${action.name}.cwd`, action.cwd);
    if (!Array.isArray(action.command) || action.command.length === 0) {
      throw new ToolingError('DISPATCH_CONFIG_INVALID', `${action.name}.command doit etre une liste d'arguments.`, 400);
    }
    action.command.forEach((arg, index) => assertPlainText(`${action.name}.command[${index}]`, String(arg)));
    return {
      name: action.name,
      cwd: action.cwd,
      command: action.command.map(String),
      background: action.background !== false,
      tailLines: Number.isInteger(action.tailLines) && action.tailLines > 0 ? action.tailLines : 20,
      description: action.description ? String(action.description).replace(/[\r\n]/g, ' ') : ''
    };
  });

  return { statusAction, actions };
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (values[key] !== undefined ? values[key] : match));
}

const CHILD_PROGRAM = String.raw`lock="$1"; name="$2"; dir="$3"; notify_mode="$4"; msg_done="$5"; msg_failed="$6"; msg_missing="$7"; shift 7
trap 'rm -rf "$lock"' EXIT
status=1
if cd "$dir"; then "$@"; status=$?; else echo "$msg_missing $dir"; fi
echo "@@ exit=$status"
if [ "$status" = 0 ]; then msg="$msg_done"; else msg="$msg_failed"; fi
if [ "$notify_mode" = macos ]; then
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' "$name" "$msg" >/dev/null 2>&1 || true
fi
exit "$status"`;

/**
 * Generates the forced-command script. The key it is bound to can run the
 * listed actions and nothing else: the requested name must match
 * ^[a-z][a-z0-9-]{0,63}$ as a whole (anything else is refused, never
 * "cleaned" into a valid name), then equal one entry of a fixed `case`.
 * Every path and argument is quoted when the script is written, so nothing
 * received over SSH is ever evaluated.
 */
function generateDispatcherScript(config = {}) {
  const { statusAction, actions } = normalizeActions(config);
  const messages = { ...DEFAULT_MESSAGES, ...(config.messages || {}) };
  const logDir = config.logDir || '~/.local/state/astratra-dispatch';
  const notifyMode = config.notify === 'macos' ? 'macos' : 'none';
  const statusLines = Number.isInteger(config.statusLines) && config.statusLines > 0 ? config.statusLines : 4;
  const names = actions.map((action) => action.name).concat(statusAction);
  assertPlainText('logDir', logDir);

  const lines = [
    '#!/usr/bin/env bash',
    '# Forced command for one SSH key: only the actions below can run.',
    '# Generated by @astratra/tooling (dispatch:generate). Edit the config, then regenerate.',
    '#',
    ...actions.map((action) => `#   ${action.name}${action.description ? ` — ${action.description}` : ''}`),
    `#   ${statusAction} — state of the launched actions`,
    'set -uo pipefail'
  ];

  if (Array.isArray(config.path) && config.path.length > 0) {
    config.path.forEach((entry) => assertPlainText('path', entry));
    lines.push(`PATH=${config.path.map(homeAware).join(':')}`, 'export PATH');
  }

  lines.push(
    `LOG_DIR=${homeAware(logDir)}`,
    'mkdir -p "$LOG_DIR" && chmod 700 "$LOG_DIR"',
    `NOTIFY_MODE=${shellQuote(notifyMode)}`,
    'RAW="${SSH_ORIGINAL_COMMAND-${1-}}"',
    `if [[ ! "$RAW" =~ ^[a-z][a-z0-9-]{0,63}$ ]]; then echo ${shellQuote(messages.refused)}; exit 2; fi`,
    'ACTION="$RAW"',
    `read -r -d '' CHILD <<'ASTRATRA_CHILD'`,
    CHILD_PROGRAM,
    'ASTRATRA_CHILD',
    '',
    'launch() {',
    '  local name="$1" dir="$2"; shift 2',
    '  local lock="$LOG_DIR/$name.lock" pid',
    '  if ! mkdir "$lock" 2>/dev/null; then',
    '    pid="$(cat "$lock/pid" 2>/dev/null || true)"',
    '    if [ -z "$pid" ] || kill -0 "$pid" 2>/dev/null; then',
    `      echo ${shellQuote(fill(messages.alreadyRunning, { status: statusAction }))} | sed "s/{name}/$name/"`,
    '      return 0',
    '    fi',
    '    rm -rf "$lock"',
    `    mkdir "$lock" 2>/dev/null || { echo ${shellQuote(messages.lockBusy)} | sed "s/{name}/$name/"; return 1; }`,
    '  fi',
    '  local log="$LOG_DIR/$name-$(date +%Y%m%d-%H%M%S).log"',
    '  ln -sf "$log" "$LOG_DIR/$name.latest.log"',
    `  nohup bash -c "$CHILD" _ "$lock" "$name" "$dir" "$NOTIFY_MODE" ${shellQuote(messages.done)} ${shellQuote(messages.failed)} ${shellQuote(messages.missingDir)} "$@" >"$log" 2>&1 </dev/null &`,
    '  echo "$!" > "$lock/pid"',
    `  echo ${shellQuote(fill(messages.launched, { status: statusAction }))} | sed "s/{name}/$name/"`,
    '}',
    '',
    'show_status() {',
    '  local found=0 latest name state',
    '  for latest in "$LOG_DIR"/*.latest.log; do',
    '    [ -e "$latest" ] || continue',
    '    found=1',
    '    name="$(basename "$latest" .latest.log)"',
    `    if [ -d "$LOG_DIR/$name.lock" ]; then state=${shellQuote(messages.running)}; else state=${shellQuote(messages.finished)}; fi`,
    '    echo "── $name ($state)"',
    `    tail -n ${statusLines} "$latest" | cut -c1-160`,
    '  done',
    `  [ "$found" = 1 ] || echo ${shellQuote(messages.noneYet)}`,
    '}',
    '',
    'case "$ACTION" in'
  );

  for (const action of actions) {
    const command = action.command.map(shellQuote).join(' ');
    if (action.background) {
      lines.push(`  ${action.name}) launch ${shellQuote(action.name)} ${homeAware(action.cwd)} ${command} ;;`);
    } else {
      lines.push(`  ${action.name}) (cd ${homeAware(action.cwd)} && ${command}) 2>&1 | tail -n ${action.tailLines} ;;`);
    }
  }

  lines.push(
    `  ${statusAction}) show_status ;;`,
    `  *) echo ${shellQuote(`${messages.unknown} ${names.join(', ')}`)}; exit 1 ;;`,
    'esac',
    ''
  );

  return lines.join('\n');
}

/**
 * The authorized_keys line that binds a public key to the script: the key
 * can then run the script and nothing else — no shell, no tunnel, no agent.
 */
function authorizedKeysLine({ scriptPath, publicKey, from }) {
  if (!SCRIPT_PATH.test(String(scriptPath || ''))) {
    throw new ToolingError('DISPATCH_SCRIPT_PATH_INVALID', 'Chemin du script : absolu, sans espace ni caractere special.', 400);
  }
  const key = String(publicKey || '').trim();
  const match = PUBLIC_KEY.exec(key);
  if (!match) {
    throw new ToolingError('DISPATCH_PUBLIC_KEY_INVALID', 'Cle publique SSH non reconnue (une seule ligne, sans options).', 400);
  }
  const options = [`command="${scriptPath}"`];
  if (from !== undefined) {
    if (!/^[A-Za-z0-9.:*?!,/-]+$/.test(String(from))) {
      throw new ToolingError('DISPATCH_FROM_INVALID', 'Motif from= invalide.', 400);
    }
    options.push(`from="${from}"`);
  }
  options.push(...KEY_RESTRICTIONS);
  return `${options.join(',')} ${match[1]} ${match[2]}${match[3] ? ` ${match[3]}` : ''}`;
}

module.exports = {
  ACTION_NAME,
  DEFAULT_MESSAGES,
  KEY_RESTRICTIONS,
  authorizedKeysLine,
  generateDispatcherScript,
  resolveDispatchAction
};
