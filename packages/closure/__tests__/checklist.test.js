const { createClosureChecklist } = require('../src');

const school = () => createClosureChecklist([
  { id: 'deliberations', label: 'Délibérations à trancher', blocking: true },
  { id: 'unjustified_absences', label: 'Absences sans justificatif', blocking: false },
  { id: 'unpaid_fees', label: 'Frais impayés', blocking: false }
]);

describe('the checklist', () => {
  test('a clean period may close', () => {
    const list = school().build({ deliberations: 0, unjustified_absences: 0, unpaid_fees: 0 });

    expect(list.canClose).toBe(true);
    expect(list.remaining).toBe(0);
    expect(list.items.every((item) => item.done)).toBe(true);
  });

  test('a blocking item FORBIDS closing — an undecided deliberation commits a child\'s future', () => {
    const list = school().build({ deliberations: 2 });

    expect(list.canClose).toBe(false);
    expect(list.blocking).toBe(1);
  });

  test('a non-blocking item does NOT forbid closing — an unpaid fee is negotiated, not a lock', () => {
    const list = school().build({ unpaid_fees: 12 });

    expect(list.canClose).toBe(true);
    expect(list.items.find((item) => item.id === 'unpaid_fees')).toMatchObject({
      remaining: 12, needsAcknowledgement: true, done: false
    });
  });

  test('each item says what remains, so people can act on it', () => {
    const list = school().build({ deliberations: 3, unjustified_absences: 7 });

    const byId = Object.fromEntries(list.items.map((item) => [item.id, item]));
    expect(byId.deliberations.remaining).toBe(3);
    expect(byId.unjustified_absences.remaining).toBe(7);
    expect(byId.unpaid_fees.remaining).toBe(0);
    expect(list.remaining).toBe(2);
  });

  test('a missing or garbage count reads as zero, not as a crash', () => {
    const list = school().build({ deliberations: 'n/a', unpaid_fees: -5 });

    expect(list.items.find((i) => i.id === 'deliberations').remaining).toBe(0);
    expect(list.items.find((i) => i.id === 'unpaid_fees').remaining).toBe(0);
  });
});

describe('closing with acknowledgements', () => {
  test('closing over an open non-blocking item requires an explicit tick', () => {
    /* Closing with unpaid fees is legitimate — doing it WITHOUT HAVING LOOKED
       is not. */
    const checklist = school().build({ unpaid_fees: 12 });

    expect(school().canCloseWith(checklist, [])).toEqual({ ok: false, reason: 'unacknowledged', unseen: ['unpaid_fees'] });
    expect(school().canCloseWith(checklist, ['unpaid_fees'])).toEqual({ ok: true });
  });

  test('no acknowledgement can override a blocking item', () => {
    const checklist = school().build({ deliberations: 1 });

    expect(school().canCloseWith(checklist, ['deliberations', 'unpaid_fees', 'unjustified_absences']))
      .toEqual({ ok: false, reason: 'blocking' });
  });

  test('every open non-blocking item must be ticked, and the missing ones are NAMED', () => {
    const checklist = school().build({ unjustified_absences: 3, unpaid_fees: 12 });

    const refusal = school().canCloseWith(checklist, ['unpaid_fees']);
    expect(refusal).toEqual({ ok: false, reason: 'unacknowledged', unseen: ['unjustified_absences'] });
  });

  test('ticking boxes in advance does not pre-approve problems', () => {
    /* An acknowledgement for an item that needs none is ignored, not
       rewarded. */
    const clean = school().build({});

    expect(school().canCloseWith(clean, ['unpaid_fees'])).toEqual({ ok: true });
  });

  test('a null or foreign checklist is refused as blocking', () => {
    expect(school().canCloseWith(null)).toEqual({ ok: false, reason: 'blocking' });
    expect(school().canCloseWith(undefined)).toEqual({ ok: false, reason: 'blocking' });
  });
});

describe('wiring', () => {
  test('no checks, a check with no id, or a duplicated id — refused up front', () => {
    expect(() => createClosureChecklist([])).toThrow(/at least one check/);
    expect(() => createClosureChecklist([{ blocking: true }])).toThrow(/id/);
    expect(() => createClosureChecklist([{ id: 'a' }, { id: 'a' }])).toThrow(/twice/);
  });
});
