/**
 * The contract every carrier (or aggregator) honours. Routes and screens only
 * ever speak to this contract: changing aggregator means writing another
 * implementation, nothing else.
 *
 * Vocabulary: "label created" is NOT "parcel picked up". Only a carrier event
 * (first scan) moves a parcel to picked_up.
 */
class Carrier {
  /** Short name stored next to a parcel (for example "sendcloud"). */
  get name() { throw new Error('Carrier.name is not implemented.'); }

  /** { configured, missing: string[] } — never a key value. */
  status() { throw new Error('Carrier.status() is not implemented.'); }

  /** Methods for a destination country (ISO 3166-1 alpha-2) and a weight in grams. */
  async shippingMethods(_query) { throw new Error('Carrier.shippingMethods() is not implemented.'); }

  /** Creates the parcel and its label: { parcelId, trackingNumber, trackingUrl, carrier, service, testMode }. */
  async createLabel(_input) { throw new Error('Carrier.createLabel() is not implemented.'); }

  /** The label PDF: { content: Buffer, type: 'application/pdf' } (format 'a4' or 'a6'). */
  async downloadLabel(_input) { throw new Error('Carrier.downloadLabel() is not implemented.'); }

  /** { status: 'cancelled' | 'requested' }. */
  async cancelLabel(_input) { throw new Error('Carrier.cancelLabel() is not implemented.'); }

  /** Service points near an address or coordinates, nearest first. */
  async servicePoints(_query) { throw new Error('Carrier.servicePoints() is not implemented.'); }

  /** Checks a webhook signature on the RAW body, in constant time. */
  verifySignature(_rawBody, _signature) { throw new Error('Carrier.verifySignature() is not implemented.'); }

  /**
   * Reads a tracking event: { parcelId, trackingNumber, trackingUrl, message, stage } or null for an
   * event that is not a parcel status change. stage: 'picked_up' | 'delivered' | 'incident' | null.
   */
  readEvent(_json) { throw new Error('Carrier.readEvent() is not implemented.'); }
}

module.exports = { Carrier };
