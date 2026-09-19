import {
  DEFAULT_JARGON,
  collectMessages,
  createLanguageLeakCheck,
  createLanguageResolver,
  createMessageAudit,
  createMessageCatalog,
  createRecipientLanguage,
  createRecipientReloader,
  createTranslationMiddleware,
  findDuplicateKeys,
  findHardcodedSubjects,
  htmlLanguage,
  scanSourceTree,
  visibleText
} from './src';
import type {
  AuditFindings,
  DuplicateKeysReport,
  HardcodedSubject,
  LanguageLeakCheck,
  LanguageLeakResult,
  RecipientLanguage,
  RecipientReloader,
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

interface Account { id: string; email: string; lang?: string; emailLang?: string }

const recipientLanguage: RecipientLanguage = createRecipientLanguage({
  languages: ['fr', 'en', 'es'],
  mailField: 'emailLang',
  interfaceFields: ['lang', 'preferences.lang'],
  followValue: 'auto'
});
const mailLanguage: string = recipientLanguage.languageOf({ lang: 'fr', emailLang: 'en' }, { headers: {} });
const acceptable: boolean = recipientLanguage.isChoice('auto');

const reloader: RecipientReloader<Account> = createRecipientReloader<Account>({
  load: async (id, fields) => ({ id: String(id), email: fields.join(','), lang: 'fr' }),
  fields: ['email'],
  language: recipientLanguage
});

const duplicates: DuplicateKeysReport = findDuplicateKeys('const DICT = { a: 1 };', { start: /const DICT/ });
const subjects: HardcodedSubject[] = findHardcodedSubjects('sendEmail(to, "Hi", t)', {
  callee: 'sendEmail', argument: 1, test: /\p{L}/u, ignore: [/TEAM/]
});
const treeFindings: Array<HardcodedSubject & { file: string }> = scanSourceTree({
  root: '/tmp/example',
  inspect: (source) => findHardcodedSubjects(source, { callee: 'mailer.send', property: 'subject' }),
  ignore: ['node_modules']
});

const leak: LanguageLeakCheck = createLanguageLeakCheck({ markers: { fr: ['vous', /\bvotre\b/i] }, requireHtmlLang: true });
const leakResult: LanguageLeakResult = leak.inspect({ subject: 'Hello', html: '<html lang="en"></html>' }, 'en');
const readable: string = visibleText('<p>Hi</p>');
const declared: string | null = htmlLanguage('<html lang="en">');

async function exercise(req: RequestLike, res: ResponseLike, next: NextFunction): Promise<void> {
  void middleware(req, res, next);
  const reloaded = await reloader.reload({ id: 'u1' }, 'staff');
  void [translated, known, served, report, filled, language, findings.clean, lines, audit.minWords];
  void [mailLanguage, acceptable, reloaded, reloader.fields, duplicates.duplicates, subjects, treeFindings];
  void [leakResult.clean, leak.describe(leakResult), readable, declared];
}

void exercise;
