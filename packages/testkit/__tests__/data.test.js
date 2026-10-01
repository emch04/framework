'use strict';

const { createFakeData, supportedCountries, EMAIL_DOMAIN } = require('../src');

describe('fausses données par pays', () => {
  test('la même graine et le même pays donnent exactement la même suite', () => {
    const a = createFakeData({ country: 'CD', seed: 42 });
    const b = createFakeData({ country: 'CD', seed: 42 });
    expect(a.people(5)).toEqual(b.people(5));
    expect(createFakeData({ country: 'CD', seed: 43 }).people(5)).not.toEqual(createFakeData({ country: 'CD', seed: 42 }).people(5));
  });

  test('RDC : numéros +243, noms et villes congolais, pas de code postal', () => {
    const data = createFakeData({ country: 'CD', seed: 1 });
    for (const person of data.people(40)) {
      expect(person.phone).toMatch(/^\+243 (81|82|83|84|85|89|97|98|99) \d{3} \d{4}$/);
      expect(person.address.countryCode).toBe('CD');
      expect(person.address.postalCode).toBeNull();
      expect(['Kinshasa', 'Lubumbashi', 'Goma', 'Mbuji-Mayi', 'Kisangani', 'Bukavu', 'Kananga', 'Likasi', 'Kolwezi', 'Matadi']).toContain(person.address.city);
    }
  });

  test('France : numéros +33 6/7 et code postal à 5 chiffres', () => {
    const data = createFakeData({ country: 'fr', seed: 5 });
    for (const person of data.people(30)) {
      expect(person.phone).toMatch(/^\+33 [67]( \d{2}){4}$/);
      expect(person.address.postalCode).toMatch(/^\d{5}$/);
    }
  });

  test('chaque pays géré produit une personne complète', () => {
    for (const code of supportedCountries()) {
      const person = createFakeData({ country: code, seed: 3 }).person();
      expect(person.firstName).toBeTruthy();
      expect(person.lastName).toBeTruthy();
      expect(person.phone).toMatch(/^\+\d/);
      expect(person.address.city).toBeTruthy();
      expect(person.address.countryCode).toBe(code);
    }
  });

  test('âge borné, date de naissance indépendante du jour d’exécution', () => {
    const data = createFakeData({ country: 'FR', seed: 9 });
    for (const person of data.people(30, { minAge: 6, maxAge: 12 })) {
      const years = (Date.parse('2026-01-01') - Date.parse(person.birthDate)) / (365.25 * 86_400_000);
      expect(years).toBeGreaterThanOrEqual(5.9);
      expect(years).toBeLessThanOrEqual(13.1);
    }
  });

  test('e-mails sur le domaine réservé, uniques ; sexe respecté', () => {
    const people = createFakeData({ country: 'JP', seed: 2 }).people(20, { sex: 'male' });
    const emails = people.map((p) => p.email);
    expect(new Set(emails).size).toBe(20);
    expect(emails.every((email) => email.endsWith(`@${EMAIL_DOMAIN}`))).toBe(true);
    expect(people.every((p) => p.sex === 'male')).toBe(true);
  });

  test('erreurs : pays inconnu, graine non entière, nombre négatif', () => {
    expect(() => createFakeData({ country: 'ZZ' })).toThrow('UNSUPPORTED_COUNTRY');
    expect(() => createFakeData({ seed: 1.5 })).toThrow('SEED_MUST_BE_INTEGER');
    expect(() => createFakeData().people(-1)).toThrow('INVALID_COUNT');
  });

  test('organisation avec adresse du pays', () => {
    const org = createFakeData({ country: 'CD', seed: 8 }).organization();
    expect(org.name).toBeTruthy();
    expect(org.address.countryCode).toBe('CD');
  });
});
