'use strict';

const { Faker } = require('@faker-js/faker');
const { COUNTRIES, localesFor } = require('./countries');

// Date de référence fixe : sans elle, « âge » dépend du jour d'exécution et la graine ne reproduit plus rien.
const REFERENCE_DATE = '2026-01-01T00:00:00.000Z';
const EMAIL_DOMAIN = 'example.test';

function slug(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

/** Développe `N`, `#` et `(a|b)` d'un format de téléphone. */
function fillPattern(faker, pattern) {
  return pattern
    .replace(/\(([^)]+)\)/g, (_, choices) => faker.helpers.arrayElement(choices.split('|')))
    .replace(/[#N]/g, (c) => String(c === 'N' ? faker.number.int({ min: 2, max: 9 }) : faker.number.int({ min: 0, max: 9 })));
}

/**
 * Fausses données réalistes pour un pays, reproductibles : deux générateurs
 * créés avec la même graine et le même pays produisent exactement la même
 * suite. Les adresses e-mail utilisent `example.test` (domaine réservé, jamais
 * livré) : un test ne peut pas écrire à un vrai destinataire.
 */
function createFakeData({ country = 'FR', seed = 1 } = {}) {
  const code = String(country).toUpperCase();
  const config = COUNTRIES[code];
  if (!config) throw new RangeError(`UNSUPPORTED_COUNTRY: ${country}`);
  if (!Number.isInteger(seed)) throw new TypeError('SEED_MUST_BE_INTEGER');
  const faker = new Faker({ locale: localesFor(code) });
  faker.seed(seed);
  let counter = 0;

  function phone() {
    return fillPattern(faker, faker.helpers.arrayElement(config.phone));
  }

  function address() {
    if (config.cities) {
      const city = faker.helpers.arrayElement(config.cities);
      return {
        street: `${faker.number.int({ min: 1, max: 250 })}, ${faker.helpers.arrayElement(config.streets)}`,
        district: faker.helpers.arrayElement(config.districts),
        city,
        region: faker.helpers.arrayElement(config.regions),
        postalCode: null,
        country: config.name,
        countryCode: code
      };
    }
    return {
      street: faker.location.streetAddress(),
      district: null,
      city: faker.location.city(),
      region: faker.location.state(),
      postalCode: faker.location.zipCode(),
      country: config.name,
      countryCode: code
    };
  }

  function person({ sex, minAge = 18, maxAge = 65 } = {}) {
    const gender = sex ?? faker.helpers.arrayElement(['female', 'male']);
    let firstName;
    let lastName;
    if (config.firstNames) {
      firstName = faker.helpers.arrayElement(config.firstNames[gender]);
      lastName = faker.helpers.arrayElement(config.lastNames);
    } else {
      firstName = faker.person.firstName(gender);
      lastName = faker.person.lastName(gender);
    }
    counter += 1;
    const local = [slug(firstName), slug(lastName)].filter(Boolean).join('.') || 'personne';
    return {
      id: faker.string.uuid(),
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      sex: gender,
      birthDate: faker.date.birthdate({ min: minAge, max: maxAge, mode: 'age', refDate: REFERENCE_DATE }).toISOString().slice(0, 10),
      email: `${local}.${counter}@${EMAIL_DOMAIN}`,
      phone: phone(),
      address: address()
    };
  }

  function organization() {
    const where = address();
    return {
      id: faker.string.uuid(),
      name: faker.company.name(),
      phone: phone(),
      email: `contact.${slug(where.city) || 'organisation'}.${counter += 1}@${EMAIL_DOMAIN}`,
      address: where
    };
  }

  function list(count, factory) {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('INVALID_COUNT');
    return Array.from({ length: count }, (_, index) => factory(index));
  }

  return {
    country: code,
    seed,
    faker,
    person,
    phone,
    address,
    organization,
    people: (count, options) => list(count, () => person(options)),
    list
  };
}

function supportedCountries() {
  return Object.keys(COUNTRIES);
}

module.exports = { createFakeData, supportedCountries, EMAIL_DOMAIN };
