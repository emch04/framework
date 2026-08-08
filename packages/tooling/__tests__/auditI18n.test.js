const { auditI18n } = require('../src/commands/auditI18n');
const { DEFAULT_CONFIG, mergeConfig } = require('../src/config');
const { createTempProject, writeFile, writeJson } = require('./helpers');

describe('audit:i18n', () => {
  test('detects missing and extra keys between locale catalogs', () => {
    const rootDir = createTempProject();
    writeJson(rootDir, 'locales/fr.json', {
      common: { save: 'Sauver', cancel: 'Annuler' }
    });
    writeJson(rootDir, 'locales/en.json', {
      common: { save: 'Save', extra: 'Extra' }
    });

    const result = auditI18n(rootDir, DEFAULT_CONFIG);

    expect(result.exitCode).toBe(1);
    expect(result.referenceLocale).toBe('fr.json');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'missing', catalog: 'en.json', key: 'common.cancel' }),
      expect.objectContaining({ type: 'extra', catalog: 'en.json', key: 'common.extra' })
    ]));
  });

  test('detects static translation keys missing from all catalogs', () => {
    const rootDir = createTempProject();
    writeJson(rootDir, 'locales/en.json', {
      common: { save: 'Save' }
    });
    writeFile(rootDir, 'src/view.jsx', 'export function View({ t }) { return t("common.delete"); }');

    const result = auditI18n(rootDir, DEFAULT_CONFIG);

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'unused-key',
        file: 'src/view.jsx',
        line: 1,
        key: 'common.delete'
      })
    ]));
  });

  test('uses configured locale and source directories under --dir target root', () => {
    const rootDir = createTempProject();
    const config = mergeConfig(DEFAULT_CONFIG, {
      audit: {
        i18n: {
          localesDir: 'translations',
          sourceDirs: ['client'],
          referenceLocale: 'en.json'
        }
      }
    });
    writeJson(rootDir, 'project/translations/en.json', { action: { save: 'Save' } });
    writeJson(rootDir, 'project/translations/es.json', { action: { save: 'Guardar' } });
    writeFile(rootDir, 'project/client/view.js', 't("action.save");');

    const result = auditI18n(rootDir, config, { dir: 'project' });

    expect(result.exitCode).toBe(0);
    expect(result.referenceLocale).toBe('en.json');
  });
});
