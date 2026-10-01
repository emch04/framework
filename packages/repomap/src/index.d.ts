export interface RepoMapDefinition {
  symbol: string;
  line: number;
  text: string;
}

export interface RepoMapFile {
  path: string;
  rank: number;
  definitions: RepoMapDefinition[];
  /** Lignes de signature, dans le même ordre que `definitions`. */
  lines: number[];
}

export interface RepoMapOptions {
  /** Chemins relatifs depuis la racine, comme dans le dépôt. */
  conversationFiles?: string[];
  mentionedIdentifiers?: string[];
  budget?: number;
  /** Langages connus : javascript, typescript, tsx et python. */
  languages?: string[];
  /** Compteur injectable pour adapter le budget au tokenizer du modèle. */
  tokenCounter?: (text: string) => number;
  /** Cache réutilisable entre deux appels, indexé par chemin relatif. */
  cache?: Map<string, unknown>;
  /** Cache facultatif d'instances d'analyseur. */
  parserCache?: Map<string, unknown>;
  /** Répertoire contenant les grammaires WASM compilées. */
  wasmDirectory?: string;
}

export interface RepoMapResult {
  content: string;
  files: RepoMapFile[];
  tokenCount: number;
  budget: number;
  cacheSize: number;
}

/** Construit la carte de symboles d'un dépôt local. */
export function buildRepoMap(rootDirectory: string, options?: RepoMapOptions): Promise<RepoMapResult>;

/** Calcule les scores PageRank sur des arêtes orientées pondérées. */
export function pagerank(files: Array<{ path: string }>, edges: Array<{ from: string; to: string; weight: number }>): Map<string, number>;
