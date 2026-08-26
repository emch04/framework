const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/__tests__/**/*.js', '**/test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        jest: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        before: 'readonly',
        after: 'readonly'
      }
    }
  },
  {
    files: ['packages/create-astratra-app/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['packages/saas-kit-ui/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^[A-Z]'
      }],
      'no-undef': 'off'
    }
  },
  {
    files: ['packages/react/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        fetch: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        globalThis: 'readonly'
      }
    },
    rules: {
      'no-undef': 'off'
    }
  },
  {
    files: ['examples/dashboard-ui/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        console: 'readonly',
        process: 'readonly',
        URLSearchParams: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^[A-Z]'
      }],
      'no-undef': 'off'
    }
  },
  {
    files: ['examples/dashboard-ui/test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        test: 'readonly'
      }
    }
  },
  {
    files: ['packages/native/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        localStorage: 'readonly'
      }
    }
  },
  {
    /* The mobile template is source for ANOTHER project — Expo/React Native,
       TSX, its own toolchain. Linting it with this repo's Node rules reports
       nothing true. */
    ignores: ['**/node_modules/**', '**/coverage/**', '**/dist/**', 'packages/create-astratra-app/templates/**']
  }
];
