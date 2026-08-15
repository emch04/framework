const fs = require('fs');
const path = require('path');
const { AppError } = require('@astratra/core');

const DEFAULT_CONFIG = {
  audit: {
    secrets: {
      dirs: ['src']
    },
    routes: {
      dirs: ['src'],
      authMiddlewarePatterns: [
        'authMiddleware',
        'auth\\.middleware',
        'isAuthenticated',
        'requireAuth',
        'internalAuth',
        'requireInternalServiceKey',
        'requireInternalKey',
        'checkInternalKey',
        'authorizeRoles',
        'parseProxyUser',
        'proxyAuth'
      ],
      publicMarkers: ['public', 'webhook', 'callback', 'oauth', 'health', 'status\\b']
    },
    i18n: {
      localesDir: 'locales',
      sourceDirs: ['src'],
      referenceLocale: null
    },
    deps: {
      // npm's own severity scale: info < low < moderate < high < critical.
      severityThreshold: 'moderate'
    }
  },
  test: {
    workspaces: null
  },
  deploy: {
    steps: [],
    modes: {}
  }
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) {
    return base;
  }

  const merged = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = mergeConfig(base[key], value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function loadConfig(rootDir = process.cwd()) {
  const jsonPath = path.join(rootDir, 'astratra.config.json');
  const jsPath = path.join(rootDir, 'astratra.config.js');

  let projectConfig = {};

  if (fs.existsSync(jsonPath)) {
    projectConfig = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } else if (fs.existsSync(jsPath)) {
    const loaded = require(jsPath);
    projectConfig = typeof loaded === 'function' ? loaded({ rootDir }) : loaded;
  }

  if (!isPlainObject(projectConfig)) {
    throw new AppError('astratra config must export an object', 500);
  }

  return mergeConfig(DEFAULT_CONFIG, projectConfig);
}

module.exports = {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig
};
