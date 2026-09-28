const { runProcess } = require('../processRunner');

/**
 * Desktop notification, macOS only (osascript), silent everywhere else.
 * Title and text travel as osascript arguments (`on run argv`), never spliced
 * into the AppleScript source, so a quote in a message cannot break out.
 */
function createDesktopNotifier(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.runProcess || runProcess;
  const prefix = options.titlePrefix ? `${options.titlePrefix} — ` : '';

  if (options.enabled === false || platform !== 'darwin') {
    return async () => {};
  }

  return async (title, message) => {
    try {
      await run('osascript', [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e', 'end run',
        `${prefix}${title}`,
        String(message)
      ], { quiet: true });
    } catch (_error) {
      // a notification never fails a publish
    }
  };
}

module.exports = {
  createDesktopNotifier
};
