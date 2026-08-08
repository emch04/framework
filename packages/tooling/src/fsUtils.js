const fs = require('fs');
const path = require('path');

const DEFAULT_SKIPPED_DIRS = new Set([
  'node_modules',
  'tests',
  '__tests__',
  'reports',
  'coverage',
  '.git'
]);

function resolveProjectPath(rootDir, value) {
  if (!value) {
    return rootDir;
  }

  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function walkFiles(dir, options = {}, files = []) {
  const skippedDirs = options.skippedDirs || DEFAULT_SKIPPED_DIRS;
  const include = options.include || (() => true);

  if (!fs.existsSync(dir)) {
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) {
        walkFiles(fullPath, options, files);
      }
      continue;
    }

    if (include(entry.name, fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

module.exports = {
  DEFAULT_SKIPPED_DIRS,
  lineNumberAt,
  readJson,
  resolveProjectPath,
  walkFiles
};
