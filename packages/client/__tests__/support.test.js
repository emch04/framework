const { createSupportLink } = require('../src');

describe('createSupportLink', () => {
  const support = createSupportLink({ email: 'support@acme.cd' });

  test('the signature carries what support would ask for anyway', () => {
    const body = support.body({ name: 'Jean', role: 'director', appVersion: '1.4.0' });

    expect(body).toContain('Nom : Jean');
    expect(body).toContain('Version : 1.4.0');
  });

  test('empty fields are omitted, not rendered as hollow lines', () => {
    const body = support.body({ name: 'Jean', role: '', appVersion: null });

    expect(body).toContain('Nom : Jean');
    expect(body).not.toContain('Version');
    expect(body).not.toContain('Rôle');
  });

  test('nothing known at all yields no signature rather than an empty block', () => {
    expect(support.body({})).toBe('');
    expect(support.body()).toBe('');
  });

  test('labels are translatable — the module carries no language of its own', () => {
    const body = support.body({ name: 'Jean' }, { name: 'Name' });

    expect(body).toContain('Name : Jean');
  });

  test('extra fields declared at construction are rendered in order', () => {
    const withFields = createSupportLink({
      email: 'support@acme.cd',
      fields: [{ key: 'orderId', label: 'Commande' }, { key: 'name', label: 'Nom' }]
    });

    const body = withFields.body({ orderId: 'o1', name: 'Jean' });

    expect(body.indexOf('Commande')).toBeLessThan(body.indexOf('Nom'));
  });

  test('subject and body are encoded — an accent or a newline truncates the message otherwise', () => {
    const link = support.mailto('Problème de connexion', '\n\n—\nNom : Jean');

    expect(link.startsWith('mailto:support@acme.cd?')).toBe(true);
    expect(link).toContain('subject=Probl%C3%A8me%20de%20connexion');
    expect(link).toContain('body=%0A%0A');
    expect(link).not.toContain(' ');
  });

  test('an empty body leaves the parameter out entirely', () => {
    expect(support.mailto('Bonjour')).toBe('mailto:support@acme.cd?subject=Bonjour');
  });

  test('the address can be overridden per call, for a second desk', () => {
    expect(support.mailto('Facture', '', 'billing@acme.cd')).toContain('mailto:billing@acme.cd?');
  });

  test('requires an address', () => {
    expect(() => createSupportLink({})).toThrow(/email/i);
  });
});
