import { blockHeight, defaultBottom, drawTable, fitText, keepTogether, line } from './src';
import type { PdfDocumentLike, TableColumn, TableResult } from './src';

interface Result {
  subject: string;
  score: number;
  comment: string;
}

declare const doc: PdfDocumentLike;

const fitted: string = fitText(doc, 'Institut de la Lumière du Savoir', 195);
const drawn: unknown = line(doc, 'Kinshasa', 40, 100, 195, { align: 'center' });
const height: number = blockHeight(doc, 'Une appréciation un peu longue.', 120);
const bottom: number = defaultBottom(doc, 60);
const resumeY: number = keepTogether(doc, { y: 650, height: 130, bottom, top: 55 });

const columns: Array<TableColumn<Result>> = [
  { key: 'subject', label: 'MATIÈRE', width: 200 },
  { key: 'score', label: 'NOTE', width: 60, align: 'right', format: (value) => `${value} / 20` },
  { key: 'comment', label: 'APPRÉCIATION', wrap: true, fontSize: 7 }
];

const table: TableResult = drawTable<Result>(doc, {
  columns,
  rows: [{ subject: 'Mathématiques', score: 14, comment: 'Bien.' }],
  x: 40,
  y: 100,
  width: 515,
  bottom,
  top: 50,
  onNewPage: (page) => void page,
  minRowHeight: 20,
  padding: 12,
  cellPadding: 5,
  zebra: '#FAFAFA',
  headerFont: 'Helvetica-Bold',
  fontSize: 8,
  color: '#000000'
});

void [fitted, drawn, height, resumeY, table.y, table.pages, table.rows];
