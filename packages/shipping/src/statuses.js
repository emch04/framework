/**
 * Sendcloud tracking statuses (API v2, "Tracking statuses" list) mapped to the
 * three moments a shop acts on. Pure function.
 *
 * - picked_up: first scan by the carrier ("label created" is NOT a scan:
 *   "Ready to send", "Announced", "Being announced" map to null);
 * - delivered: delivered or collected by the customer;
 * - incident: the parcel will not be delivered normally;
 * - null: no action. A failed delivery attempt or a delay is not a final
 *   incident: it still counts as "on its way".
 */
const PICKED_UP = new Set([
  'shipment picked up by driver',
  'en route to sorting center',
  'at sorting centre',
  'being sorted',
  'sorted',
  'parcel en route',
  'driver en route',
  'awaiting customer pickup',
  'at customs',
  'delivery delayed',
  'delivery attempt failed',
  'delivery date changed',
  'delivery method changed',
  'delivery address changed'
]);
const DELIVERED = new Set(['delivered', 'shipment collected by customer']);
const INCIDENT = new Set(['unable to deliver', 'refused by recipient', 'returned to sender', 'address invalid', 'error collecting']);

const normalize = (message) => String(message ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** 'picked_up' | 'delivered' | 'incident' | null for a Sendcloud status label. */
function classifySendcloudStatus(message) {
  const m = normalize(message);
  if (DELIVERED.has(m)) return 'delivered';
  if (INCIDENT.has(m)) return 'incident';
  if (PICKED_UP.has(m)) return 'picked_up';
  return null;
}

module.exports = { classifySendcloudStatus };
