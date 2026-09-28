const fs = require('fs');
const path = require('path');
const { ToolingError } = require('../errors');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Same results as `npm version <level>` for major.minor.patch[-pre]. */
function bumpVersion(version, level = 'patch') {
  const match = SEMVER.exec(String(version || '').trim());
  if (!match) {
    throw new ToolingError('VERSION_INVALID', `Version illisible : ${version}`, 400);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  const prerelease = match[4];

  if (level === 'patch') {
    if (!prerelease) {
      patch += 1;
    }
  } else if (level === 'minor') {
    if (!(prerelease && patch === 0)) {
      minor += 1;
    }
    patch = 0;
  } else if (level === 'major') {
    if (!(prerelease && patch === 0 && minor === 0)) {
      major += 1;
    }
    minor = 0;
    patch = 0;
  } else {
    throw new ToolingError('VERSION_LEVEL_INVALID', `Niveau de version inconnu : ${level}`, 400);
  }

  return `${major}.${minor}.${patch}`;
}

function detectIndent(text) {
  const match = /^[ \t]+(?=")/m.exec(text);
  return match ? match[0] : '  ';
}

function rewriteJson(filePath, mutate) {
  const text = fs.readFileSync(filePath, 'utf8');
  const value = JSON.parse(text);
  mutate(value);
  const trailingNewline = text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, detectIndent(text))}${trailingNewline}`);
}

function readPackageVersion(projectDir) {
  const packagePath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new ToolingError('VERSION_NO_PACKAGE', `package.json introuvable dans ${projectDir}`, 400);
  }
  return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
}

/**
 * Bumps package.json (and package-lock.json when present, like npm does
 * with --no-git-tag-version). Nothing is committed or tagged.
 */
function applyVersionBump(projectDir, level = 'patch') {
  const from = readPackageVersion(projectDir);
  const to = bumpVersion(from, level);
  const files = [];

  const packagePath = path.join(projectDir, 'package.json');
  rewriteJson(packagePath, (value) => {
    value.version = to;
  });
  files.push(packagePath);

  const lockPath = path.join(projectDir, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    rewriteJson(lockPath, (value) => {
      if (typeof value.version === 'string') {
        value.version = to;
      }
      if (value.packages && value.packages[''] && typeof value.packages[''].version === 'string') {
        value.packages[''].version = to;
      }
    });
    files.push(lockPath);
  }

  return { from, to, files };
}

module.exports = {
  applyVersionBump,
  bumpVersion,
  readPackageVersion
};
