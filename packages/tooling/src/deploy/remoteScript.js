const { ToolingError } = require('../errors');
const { shellQuote } = require('../shell');

const MARKER = '@@astratra';

/*
 * The script runs on the server through `ssh host bash -s -- <args>`: the
 * text goes over stdin, the values as positional arguments (each one quoted
 * locally for the remote shell). Nothing is spliced into the script body, so
 * a directory or a command with a quote in it cannot change what runs.
 *
 * Every command runs as the app user in the app directory. Config commands
 * (install, reload) are the owner's own and are evaluated as written; the
 * commit ids travel as environment variables, never inside a command string.
 *
 * It prints marker lines the local side reads:
 *   @@astratra prev=<sha>         the commit that was running before
 *   @@astratra deps=changed|unchanged
 *   @@astratra result=deployed|rolled-back|rollback-failed|failed-before-change|failed-no-rollback
 */
const REMOTE_DEPLOY_SCRIPT = String.raw`set -uo pipefail
APP_USER="$1"; APP_DIR="$2"; NODE_DIR="$3"; TARGET="$4"; REMOTE="$5"; BRANCH="$6"
DEPS_RE="$7"; INSTALL="$8"; RELOAD="$9"; HEALTH="${'${10}'}"; ATTEMPTS="${'${11}'}"; INTERVAL="${'${12}'}"; TIMEOUT="${'${13}'}"; ROLLBACK="${'${14}'}"
PREV=""; DEPS_CHANGED=0
mark() { printf '@@astratra %s\n' "$1"; }
as_app() {
  local run_path="/usr/local/bin:/usr/bin:/bin"
  [ -n "$NODE_DIR" ] && run_path="$NODE_DIR/bin:$run_path"
  local vars=(PATH="$run_path" APP_DIR="$APP_DIR" TARGET="$TARGET" PREV="$PREV" REMOTE="$REMOTE" BRANCH="$BRANCH")
  if [ -n "$APP_USER" ] && [ "$(id -un)" != "$APP_USER" ]; then
    sudo -n -u "$APP_USER" -H env "${'${vars[@]}'}" bash -c 'cd "$APP_DIR" && eval "$1"' _ "$1"
  else
    env "${'${vars[@]}'}" bash -c 'cd "$APP_DIR" && eval "$1"' _ "$1"
  fi
}
healthy() {
  local url="$1" code="000" i
  for ((i = 1; i <= ATTEMPTS; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" || true)
    [ "$code" = "200" ] && return 0
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$INTERVAL"
  done
  echo "No 200 from $url (last: $code)"
  return 1
}
all_healthy() {
  local url
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    healthy "$url" || return 1
  done <<< "$HEALTH"
  return 0
}
roll_back() {
  echo "$1: rolling back to $PREV"
  if [ "$ROLLBACK" != "1" ]; then mark "result=failed-no-rollback"; exit 1; fi
  if as_app 'git reset --hard "$PREV"' \
    && { [ "$DEPS_CHANGED" != "1" ] || [ -z "$INSTALL" ] || as_app "$INSTALL"; } \
    && as_app "$RELOAD" && all_healthy; then
    echo "Previous version restored: $(as_app 'git log --oneline -1')"
    mark "result=rolled-back"
  else
    echo "Rollback did not bring the previous version back: the server needs a look."
    mark "result=rollback-failed"
  fi
  exit 1
}
if ! [[ "$TARGET" =~ ^[0-9a-f]{7,40}$ ]]; then echo "Invalid target commit."; mark "result=failed-before-change"; exit 2; fi
if ! PREV=$(as_app 'git rev-parse HEAD'); then echo "Cannot read the running commit in $APP_DIR."; mark "result=failed-before-change"; exit 1; fi
mark "prev=$PREV"
if ! as_app 'git fetch --quiet "$REMOTE" "$BRANCH"'; then echo "git fetch failed: nothing changed."; mark "result=failed-before-change"; exit 1; fi
as_app 'git reset --hard "$TARGET"' || roll_back "git reset failed"
if [ "$PREV" != "$TARGET" ] && [ -n "$DEPS_RE" ]; then
  CHANGED=$(as_app 'git diff --name-only "$PREV" HEAD') || roll_back "git diff failed"
  if grep -qE "$DEPS_RE" <<< "$CHANGED"; then DEPS_CHANGED=1; fi
fi
if [ "$DEPS_CHANGED" = "1" ] && [ -n "$INSTALL" ]; then
  mark "deps=changed"; echo "Dependencies changed: installing"
  as_app "$INSTALL" || roll_back "Install failed"
else
  mark "deps=unchanged"
fi
as_app "$RELOAD" || roll_back "Reload failed"
all_healthy || roll_back "Health check failed"
echo "Healthy inside: $(as_app 'git log --oneline -1')"
mark "result=deployed"
exit 0
`;

/*
 * Status of a running server (the "health" shortcut): internal URLs, the pm2
 * process list, the last line of a backup log that matches a pattern.
 *   @@astratra url=<code> <url>
 *   @@astratra pm2=<pm2 jlist JSON on one line, or empty>
 *   @@astratra backup=<last matching line, or empty>
 */
const REMOTE_STATUS_SCRIPT = String.raw`set -uo pipefail
APP_USER="$1"; NODE_DIR="$2"; URLS="$3"; TIMEOUT="$4"; BACKUP_LOG="$5"; BACKUP_PATTERN="$6"; USE_PM2="$7"
run_path="/usr/local/bin:/usr/bin:/bin"; [ -n "$NODE_DIR" ] && run_path="$NODE_DIR/bin:$run_path"
as_app() {
  if [ -n "$APP_USER" ] && [ "$(id -un)" != "$APP_USER" ]; then sudo -n -u "$APP_USER" -H env PATH="$run_path" "$@"; else env PATH="$run_path" "$@"; fi
}
while IFS= read -r url; do
  [ -z "$url" ] && continue
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" || true)
  printf '@@astratra url=%s %s\n' "${'${code:-000}'}" "$url"
done <<< "$URLS"
if [ "$USE_PM2" = "1" ]; then
  printf '@@astratra pm2=%s\n' "$(as_app pm2 jlist 2>/dev/null | tr -d '\n' || true)"
fi
if [ -n "$BACKUP_LOG" ]; then
  printf '@@astratra backup=%s\n' "$(as_app grep -F -- "$BACKUP_PATTERN" "$BACKUP_LOG" 2>/dev/null | tail -1 || true)"
fi
exit 0
`;

function assertNoNewline(name, value) {
  if (/[\r\n\0]/.test(String(value))) {
    throw new ToolingError('DEPLOY_CONFIG_INVALID', `${name} ne doit pas contenir de retour a la ligne.`, 400);
  }
}

function toSeconds(ms) {
  return String(Math.max(1, Math.round(Number(ms) / 1000)));
}

function buildRemoteDeployArgs(remote, target) {
  if (!/^[0-9a-f]{7,40}$/.test(String(target || ''))) {
    throw new ToolingError('DEPLOY_TARGET_INVALID', `Commit cible invalide : ${target}`, 400);
  }
  const health = remote.health || {};
  const values = [
    ['appUser', remote.appUser || ''],
    ['appDir', remote.appDir],
    ['nodeDir', remote.nodeDir || ''],
    ['target', target],
    ['remote', remote.remote],
    ['branch', remote.branch],
    ['depsPattern', remote.depsPattern || ''],
    ['installCommand', remote.installCommand || ''],
    ['reloadCommand', remote.reloadCommand]
  ];
  for (const [name, value] of values) {
    assertNoNewline(name, value);
  }
  for (const url of health.internal || []) {
    assertNoNewline('health.internal', url);
  }

  return [
    ...values.map(([, value]) => String(value)),
    (health.internal || []).join('\n'),
    String(health.attempts || 12),
    toSeconds(health.intervalMs || 5000),
    toSeconds(health.timeoutMs || 5000),
    remote.rollback === false ? '0' : '1'
  ];
}

/** `ssh [options] host bash -s -- 'arg1' 'arg2'...` — ssh joins its arguments into one remote command line. */
function buildSshInvocation({ host, sshOptions = [], args = [] }) {
  if (!host || /^-/.test(host) || /[\s'"`$;&|<>]/.test(host)) {
    throw new ToolingError('DEPLOY_HOST_INVALID', `Hote SSH invalide : ${host}`, 400);
  }
  return {
    command: 'ssh',
    args: [...sshOptions, host, 'bash', '-s', '--', ...args.map(shellQuote)]
  };
}

function parseMarkers(stdout) {
  const markers = {};
  const urls = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith(`${MARKER} `)) {
      continue;
    }
    const body = line.slice(MARKER.length + 1);
    const separator = body.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = body.slice(0, separator);
    const value = body.slice(separator + 1);
    if (key === 'url') {
      const space = value.indexOf(' ');
      urls.push({ status: Number(value.slice(0, space)) || 0, url: value.slice(space + 1) });
    } else {
      markers[key] = value;
    }
  }
  if (urls.length > 0) {
    markers.urls = urls;
  }
  return markers;
}

function pm2ReloadCommand({ ecosystem, only }) {
  if (!ecosystem) {
    throw new ToolingError('DEPLOY_CONFIG_INVALID', 'pm2.ecosystem manquant.', 400);
  }
  const onlyPart = only ? ` --only ${shellQuote(Array.isArray(only) ? only.join(',') : only)}` : '';
  return `pm2 startOrReload ${shellQuote(ecosystem)}${onlyPart} --update-env && pm2 save`;
}

module.exports = {
  MARKER,
  REMOTE_DEPLOY_SCRIPT,
  REMOTE_STATUS_SCRIPT,
  buildRemoteDeployArgs,
  buildSshInvocation,
  parseMarkers,
  pm2ReloadCommand
};
