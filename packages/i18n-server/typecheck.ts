import {
  DEFAULT_JARGON,
  collectMessages,
  createLanguageResolver,
  createMessageAudit,
  createMessageCatalog,
  createTranslationMiddleware
} from './src';
import type {
  AuditFindings,
  LanguageCoverage,
  LanguageResolver,
  MessageAudit,
  MessageCatalog,
  MessageEntry,
  NextFunction,
  RequestHandler,
  RequestLike,
  ResponseLike
} from './src';

const catalog: MessageCatalog = createMessageCatalog({
  languages: ['fr', 'en', 'es'],
  defaultLanguage: 'fr',
  messages: {
    'Cet élève est introuvable.': { en: 'This student could not be found.', es: 'No se encuentra a este alumno.' }
  }
});

const translated: string = catalog.translate('Cet élève est introuvable.', 'en');
const known: boolean = catalog.has('Cet élève est introuvable.');
const served: boolean = catalog.supports('es');
const report: Record<string, LanguageCoverage> = catalog.coverage();
const filled: number = catalog.size();

const resolver: LanguageResolver = createLanguageResolver({
  languages: ['fr', 'en', 'es'],
  defaultLanguage: 'fr',
  read: (req) => (req.user as { language?: string } | undefined)?.language
});

const language: string = resolver.resolveLanguage({ headers: { 'accept-language': 'en' } });

const middleware: RequestHandler = createTranslationMiddleware({
  catalog,
  resolver,
  fields: ['message', 'title'],
  attach: 'language'
});

const audit: MessageAudit = createMessageAudit({
  jargon: [...DEFAULT_JARGON, /\bwidget\b/i],
  minWords: 3,
  allow: ['OK']
});

const entries: MessageEntry[] = collectMessages({
  root: '/tmp/example',
  pattern: /apiResponse\(\s*res\s*,\s*[45]\d{2}\s*,\s*"([^"]+)"/g,
  extensions: ['.js', '.ts'],
  ignore: ['node_modules']
});

const findings: AuditFindings = audit.inspect(entries);
const lines: string[] = audit.describe(findings);

function exercise(req: RequestLike, res: ResponseLike, next: NextFunction): void {
  void middleware(req, res, next);
  void [translated, known, served, report, filled, language, findings.clean, lines, audit.minWords];
}

void exercise;
