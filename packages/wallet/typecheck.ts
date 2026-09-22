import {
  checkAppleCredentials, checkGoogleCredentials, createApplePasses, createAppleWebServiceRouter,
  createGoogleWallet, createMemoryRegistrationStore, fromHexField, readPassCertificate, toHexField
} from './src';
import type { CheckResult, PassContent, RegistrationStore } from './src';

declare const pem: string;
declare const key: string;

const check: CheckResult = checkAppleCredentials({ certificate: pem, privateKey: key });
const googleCheck: CheckResult = checkGoogleCredentials({ issuerId: '3388000000000000000' });
const info = readPassCertificate(pem);
const passes = createApplePasses({
  certificate: pem, privateKey: key, webServiceURL: 'https://api.example.com/wallet/apple',
  organizationName: 'Salon', description: 'Carte fidélité'
});
const card: PassContent = { serialNumber: 'C-1', authenticationToken: 'jeton-assez-long-123', barcode: { message: 'C-1' } };
const buffer: Buffer = passes.build(card);
const registrations: RegistrationStore = createMemoryRegistrationStore();
const router = createAppleWebServiceRouter({
  resolveConfig: async () => ({ passTypeIdentifier: passes.passTypeIdentifier }),
  findPass: async () => ({ authenticationToken: 'jeton-assez-long-123' }),
  buildPass: async () => buffer,
  registrations
});
const google = createGoogleWallet({ issuerId: '3388', credentials: { client_email: 'a@b.c', private_key: key } });
const link: string = google.saveLink([{ id: google.objectId('C-1'), classId: google.classId('fidelite') }]);
const hex: string = toHexField(pem);
const back: string | undefined = fromHexField(hex);

export { check, googleCheck, info, router, link, back };
