const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { CARD_SIZE, imposeCards, drawQrMatrix, drawSocialLogo, SOCIAL_NETWORKS } = require('../src');

const nouveauDocument = () => new PDFDocument({ autoFirstPage: false, margin: 0 });

test('une carte bancaire mesure 85,6 × 54 mm', () => {
  expect(CARD_SIZE.width).toBeCloseTo(242.65, 1);
  expect(CARD_SIZE.height).toBeCloseTo(153.07, 1);
});

test('planche A4 : dix rectos puis dix versos en miroir horizontal, deux pages', () => {
  const doc = nouveauDocument();
  const pages = jest.spyOn(doc, 'addPage');
  const rectos = [];
  const versos = [];
  const { perPage } = imposeCards(doc, {
    front: (_doc, x, y, w, h, index) => rectos.push({ x, y, index }),
    back: (_doc, x, y, w, h, index) => versos.push({ x, y, index })
  });
  expect(perPage).toBe(10);
  expect(pages).toHaveBeenCalledTimes(2);
  // La carte 0 est en haut à gauche au recto, en haut à droite au verso.
  expect(versos[0].x).toBeCloseTo(rectos[1].x, 5);
  expect(versos[1].x).toBeCloseTo(rectos[0].x, 5);
  expect(versos[0].y).toBeCloseTo(rectos[0].y, 5);
});

test('sans verso, une seule page ; une grille trop grande est refusée', () => {
  const doc = nouveauDocument();
  const pages = jest.spyOn(doc, 'addPage');
  imposeCards(doc, { front: () => {} });
  expect(pages).toHaveBeenCalledTimes(1);
  expect(() => imposeCards(nouveauDocument(), { front: () => {}, rows: 7 })).toThrow(/ne tiennent pas/);
  expect(() => imposeCards(nouveauDocument(), { front: () => {}, paper: 'A3' })).toThrow(/inconnu/);
});

test('le QR vectoriel dessine un carré par module noir, fond compris', () => {
  const doc = nouveauDocument();
  doc.addPage();
  const modules = QRCode.create('https://www.example.com/reservation').modules;
  let noirs = 0;
  for (let r = 0; r < modules.size; r += 1) for (let c = 0; c < modules.size; c += 1) if (modules.get(r, c)) noirs += 1;
  const rect = jest.spyOn(doc, 'rect');
  drawQrMatrix(doc, modules, 10, 10, 100);
  expect(rect).toHaveBeenCalledTimes(noirs + 1);
});

test('les logos des réseaux se dessinent, un réseau inconnu est refusé', () => {
  const doc = nouveauDocument();
  doc.addPage();
  expect(SOCIAL_NETWORKS).toEqual(['instagram', 'tiktok', 'snapchat']);
  for (const reseau of SOCIAL_NETWORKS) expect(() => drawSocialLogo(doc, reseau, 10, 10, 20)).not.toThrow();
  expect(() => drawSocialLogo(doc, 'myspace', 0, 0, 10)).toThrow(/inconnu/);
});
