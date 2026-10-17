import { createMemoryEventLog, createPostgresEventLog } from '@astratra/payments';
import {
  CODES,
  ShippingError,
  messageFor,
  createSendcloudCarrier,
  SendcloudCarrier,
  classifySendcloudStatus,
  createCarrierWebhook,
  SIGNATURE_HEADER,
  type ParcelEvent,
  type ShippingMethod,
  type Label,
  type ServicePoint
} from './src';

const carrier: SendcloudCarrier = createSendcloudCarrier({
  publicKey: 'pub',
  secretKey: async () => 'secret',
  testMode: true,
  servicePointsCacheSeconds: false,
  retry: { baseDelayMs: 0 },
  breaker: { failureThreshold: 3 }
});

async function exercise() {
  const state = await carrier.status();
  void state.missing;
  const methods: ShippingMethod[] = await carrier.shippingMethods({ country: 'FR', weightGrams: 500 });
  const label: Label = await carrier.createLabel({
    orderNumber: 'R-1',
    recipient: { name: 'A', line1: 'B', city: 'C', postalCode: '75001', country: 'FR' },
    weightGrams: 500,
    method: methods[0]
  });
  const pdf = await carrier.downloadLabel({ parcelId: label.parcelId, format: 'a6' });
  void pdf.content.length;
  const cancelled: 'cancelled' | 'requested' = (await carrier.cancelLabel({ parcelId: label.parcelId })).status;
  void cancelled;
  const points: ServicePoint[] = await carrier.servicePoints({ country: 'FR', postalCode: '13002', carriers: ['mondial_relay'], limit: 10 });
  void points;
  const ok: boolean = await carrier.verifySignature(Buffer.from('{}'), 'ab');
  void ok;
  const event: ParcelEvent | null = carrier.readEvent({ action: 'parcel_status_changed' });
  void event;
}
void exercise;

const stage = classifySendcloudStatus('Delivered');
void stage;
const error = new ShippingError(CODES.NOT_CONFIGURED);
const sentence: string = messageFor(error, 'en');
void sentence;
void SIGNATURE_HEADER;

const webhook = createCarrierWebhook({
  carrier,
  eventLog: createMemoryEventLog(),
  onPickedUp: async (parcel, tools) => {
    await tools.sideEffect('email', async () => parcel.trackingNumber);
  },
  onDelivered: (parcel, tools) => tools.handled(parcel.message),
  onIncident: () => undefined
});
void webhook.receive({ payload: Buffer.from('{}'), headers: {} });
void createPostgresEventLog;
