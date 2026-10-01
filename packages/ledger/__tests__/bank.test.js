const { humain, montage } = require('./helpers');

async function erreur(promesse) {
  try {
    await promesse;
  } catch (e) {
    return e;
  }
  throw new Error('une erreur était attendue');
}

async function scenario() {
  const ledger = await montage();
  const passer = (date, montant, label) => ledger.post({ journal: 'BQ', date, label, lines: montant > 0
    ? [{ account: '5211', debit: montant }, { account: '7011', credit: montant }]
    : [{ account: '6011', debit: -montant }, { account: '5211', credit: -montant }] }, { actor: humain });
  const e = {
    depot: await passer('2026-03-01', 500000, 'Dépôt'),
    cheque: await passer('2026-03-05', -120000, 'Chèque 001'),
    virement: await passer('2026-03-10', -30000, 'Virement loyer'),
    nonPasse: await passer('2026-03-28', -45000, 'Chèque 002 pas encore débité')
  };
  await ledger.importStatement({ account: '5211', lines: [
    { id: 's1', date: '2026-03-02', label: 'VERSEMENT', amount: 500000 },
    { id: 's2', date: '2026-03-08', label: 'CHQ 001', amount: -120000 },
    { id: 's3', date: '2026-03-11', label: 'VIR LOYER', amount: -30000 },
    { id: 's4', date: '2026-03-31', label: 'FRAIS BANCAIRES', amount: -2500 }
  ] }, { actor: humain });
  return { ledger, e };
}

describe('rapprochement bancaire', () => {
  test('pointage automatique prudent puis état de rapprochement qui tombe juste', async () => {
    const { ledger, e } = await scenario();
    expect(await ledger.autoMatchStatement('5211', { actor: humain })).toEqual({ matched: 3 });
    const etat = await ledger.bankReconciliation('5211', { date: '2026-03-31' });
    expect(etat).toMatchObject({ bookBalance: 305000, statementBalance: 347500, reconciledBalance: 347500, difference: 0, balanced: true });
    expect(etat.unmatchedBook.map((l) => l.lineId)).toEqual([e.nonPasse.lines[1].id]);
    expect(etat.unmatchedStatement.map((l) => l.id)).toEqual(['s4']);
  });

  test('un solde bancaire annoncé qui ne colle pas fait apparaître l’écart', async () => {
    const { ledger } = await scenario();
    await ledger.autoMatchStatement('5211', { actor: humain });
    const etat = await ledger.bankReconciliation('5211', { date: '2026-03-31', statementBalance: 347000 });
    expect(etat).toMatchObject({ balanced: false, difference: -500 });
  });

  test('pointage manuel : sommes égales exigées, pas de double pointage, dépointage', async () => {
    const { ledger, e } = await scenario();
    expect((await erreur(ledger.matchStatement(['s2'], [e.virement.lines[1].id], { actor: humain }))).code).toBe('STATEMENT_MISMATCH');
    const p = await ledger.matchStatement(['s2', 's3'], [e.cheque.lines[1].id, e.virement.lines[1].id], { actor: humain });
    expect(p.amount).toBe(-150000);
    expect((await erreur(ledger.matchStatement(['s1'], [e.cheque.lines[1].id], { actor: humain }))).code).toBe('ALREADY_MATCHED');
    expect((await erreur(ledger.matchStatement(['s1'], [e.depot.lines[1].id], { actor: humain }))).code).toBe('INVALID_STATEMENT');
    expect((await erreur(ledger.reverse(e.cheque.id, { actor: humain }))).code).toBe('LINE_MATCHED');
    expect(await ledger.unmatchStatement('s3', { actor: humain })).toBe(true);
    const etat = await ledger.bankReconciliation('5211', { date: '2026-03-31' });
    expect(etat.unmatchedStatement.map((l) => l.id)).toEqual(['s1', 's2', 's3', 's4']);
  });

  test('l’automate ne pointe pas quand deux candidats sont possibles', async () => {
    const ledger = await montage();
    for (const date of ['2026-04-01', '2026-04-02']) {
      await ledger.post({ journal: 'BQ', date, lines: [{ account: '5211', debit: 1000 }, { account: '7011', credit: 1000 }] }, { actor: humain });
    }
    await ledger.importStatement({ account: '5211', lines: [{ id: 'x', date: '2026-04-02', amount: 1000 }] }, { actor: humain });
    expect((await ledger.autoMatchStatement('5211', { actor: humain })).matched).toBe(0);
  });

  test('réimport idempotent ; contenu différent ou compte hors trésorerie refusés', async () => {
    const { ledger } = await scenario();
    const encore = await ledger.importStatement({ account: '5211', lines: [{ id: 's1', date: '2026-03-02', label: 'VERSEMENT', amount: 500000 }] }, { actor: humain });
    expect(encore).toMatchObject({ imported: 0, skipped: 1 });
    expect((await erreur(ledger.importStatement({ account: '5211', lines: [{ id: 's1', date: '2026-03-02', amount: 1 }] }, { actor: humain }))).code).toBe('DUPLICATE_STATEMENT_LINE');
    expect((await erreur(ledger.importStatement({ account: '4111', lines: [] }, { actor: humain }))).code).toBe('INVALID_STATEMENT');
  });
});
