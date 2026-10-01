const fs = require('fs');
const path = require('path');
const { loadChart, loadTaxes, computeTax, listCharts, createChart, LedgerError } = require('../src');
const { construire, empreinte, SOURCES, COMMIT } = require('../scripts/import-odoo');

const DATA = path.join(__dirname, '..', 'data');

describe('plans OHADA importés', () => {
  test('SYSCOHADA : 1 134 comptes, classes 1 à 9, codes uniques', () => {
    const plan = loadChart('syscohada');
    expect(plan.accounts).toHaveLength(1134);
    expect(new Set(plan.accounts.map((c) => c.code)).size).toBe(1134);
    expect([...new Set(plan.accounts.map((c) => c.class))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(plan.source).toMatchObject({ repository: 'https://github.com/odoo/odoo', commit: COMMIT, license: 'LGPL-3.0-only', copyright: 'Odoo S.A.' });
  });

  test('SYSCEBNL : 453 comptes et 91 groupes', () => {
    const plan = loadChart('syscebnl');
    expect(plan.accounts).toHaveLength(453);
    expect(plan.groups).toHaveLength(91);
    expect(plan.accounts.find((c) => c.code === '131').name).toBe("Excédent de l'exercice");
  });

  test('les libellés sont ceux de la source, sans réécriture ; un libellé français absent retombe sur l’anglais', () => {
    const plan = loadChart('syscohada');
    expect(plan.accounts.find((c) => c.code === '4111')).toMatchObject({ name: 'Clients', type: 'asset_receivable', reconcile: true });
    expect(plan.accounts.find((c) => c.code === '121').name).toBe('Créancier reporté');
    const sansFrancais = plan.accounts.find((c) => c.code === '109');
    expect(sansFrancais.labels.fr).toBeUndefined();
    expect(sansFrancais.name).toBe('Contributors, subscribed capital, uncalled');
  });

  test('chaque libellé français du JSON figure mot pour mot dans le CSV d’origine', () => {
    const csv = fs.readFileSync(path.join(DATA, 'source', 'account.account-syscohada.csv'), 'utf8');
    for (const compte of loadChart('syscohada').accounts) {
      if (compte.labels.fr) expect(csv.includes(`"${compte.labels.fr.replace(/"/g, '""')}"`)).toBe(true);
    }
  });

  test('la conversion est reproductible : relancer le script redonne exactement les JSON livrés', () => {
    for (const [relatif, contenu] of Object.entries(construire())) {
      expect(JSON.parse(fs.readFileSync(path.join(DATA, relatif), 'utf8'))).toEqual(contenu);
    }
  });

  test('les empreintes enregistrées correspondent aux fichiers source conservés', () => {
    const plan = JSON.parse(fs.readFileSync(path.join(DATA, 'charts', 'syscohada.json'), 'utf8'));
    const fichier = SOURCES.find((s) => s.chemin === plan.source.files[0].path).fichier;
    expect(empreinte(fs.readFileSync(path.join(DATA, 'source', fichier)))).toBe(plan.source.files[0].sha256);
    expect(fs.readFileSync(path.join(DATA, 'source', 'LICENSE'), 'utf8')).toMatch(/GNU LESSER GENERAL PUBLIC LICENSE/);
  });

  test('plan inconnu refusé, liste des plans livrés', () => {
    expect(listCharts()).toEqual(['syscohada', 'syscebnl']);
    expect(() => loadChart('pcg')).toThrow(LedgerError);
  });

  test('plan personnalisé : doublon refusé, code hors classe refusé', () => {
    expect(() => createChart({ accounts: [{ code: '411', name: 'Clients' }, { code: '411', name: 'Bis' }] })).toThrow(/double/);
    expect(() => createChart({ accounts: [{ code: '0123', name: 'Hors classe' }] })).toThrow(/classe/);
    const plan = createChart({ accounts: [{ code: '701', name: 'Ventes' }], profile: { resultProfit: '120' } });
    expect(plan.accounts[0]).toMatchObject({ code: '701', class: 7 });
    expect(plan.profile.resultProfit).toBe('120');
  });
});

describe('taxes RDC', () => {
  const { taxes } = loadTaxes('cd', 'syscohada');
  const taxe = (id) => taxes.find((t) => t.id === id);

  test('13 taxes par plan, TVA à 16 %', () => {
    expect(taxes).toHaveLength(13);
    expect(loadTaxes('cd', 'syscebnl').taxes).toHaveLength(13);
    expect(taxe('tva_sale_16')).toMatchObject({ amount: '16.0', use: 'sale', labels: { fr: '16% Marchandises' } });
  });

  test('vente : 16 % au crédit de 4431 ; achat : au débit de 4452', () => {
    expect(computeTax(1000000, taxe('tva_sale_16'))).toEqual({
      base: 1000000, amount: 160000, lines: [{ account: '4431', debit: 0, credit: 160000, tax: { code: 'tva_sale_16', base: 1000000 } }]
    });
    expect(computeTax(1000000, taxe('tva_purchase_good_16')).lines).toEqual([
      { account: '4452', debit: 160000, credit: 0, tax: { code: 'tva_purchase_good_16', base: 1000000 } }
    ]);
  });

  test('importation en autoliquidation : la taxe est à la fois due et récupérable', () => {
    const { lines } = computeTax(50000, taxe('tva_import_goods_16'));
    expect(lines).toEqual([
      { account: '4431', debit: 0, credit: 8000, tax: { code: 'tva_import_goods_16', base: 50000 } },
      { account: '4451', debit: 8000, credit: 0, tax: { code: 'tva_import_goods_16', base: 50000 } }
    ]);
  });

  test('avoir : le sens s’inverse ; arrondi à l’unité la plus proche', () => {
    expect(computeTax(1000000, taxe('tva_sale_16'), { document: 'refund' }).lines[0]).toMatchObject({ debit: 160000, credit: 0 });
    expect(computeTax(3, taxe('tva_sale_16')).amount).toBe(0);
    expect(computeTax(4, taxe('tva_sale_16')).amount).toBe(1);
  });

  test('exonéré : pas de ligne de taxe', () => {
    expect(computeTax(1000, taxe('tva_exempt_0'))).toEqual({ base: 1000, amount: 0, lines: [] });
  });

  test('pays sans taxes livrées refusé', () => {
    expect(() => loadTaxes('fr')).toThrow(/Aucune taxe/);
  });
});
