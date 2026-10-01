/**
 * @astratra/booking — calcul des créneaux de rendez-vous et réservation sans
 * double réservation.
 */

const { computeSlots } = require('./slots');
const { createBookingService, BookingError } = require('./service');
const { getPublicHolidays, easterSunday, HOLIDAY_COUNTRIES } = require('./holidays');
const { zonedToInstant, toZoned, offsetMinutes, parseTime } = require('./time');
const {
  assertBookingStore,
  createMemoryBookingStore,
  createPostgresBookingStore,
  createMongoBookingStore
} = require('./stores');

/** Heure murale « AAAA-MM-JJ » + « HH:MM » dans un fuseau → instant ISO (UTC). */
function wallTimeToISO(date, time, timeZone) {
  return new Date(zonedToInstant(date, parseTime(time), timeZone)).toISOString();
}

module.exports = {
  computeSlots,
  createBookingService,
  BookingError,
  createMemoryBookingStore,
  createPostgresBookingStore,
  createMongoBookingStore,
  assertBookingStore,
  getPublicHolidays,
  easterSunday,
  HOLIDAY_COUNTRIES,
  wallTimeToISO,
  toZoned,
  offsetMinutes
};
