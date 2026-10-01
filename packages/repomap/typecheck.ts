import { buildRepoMap, type RepoMapOptions, type RepoMapResult } from './src';

const options: RepoMapOptions = {
  conversationFiles: ['src/index.ts'],
  mentionedIdentifiers: ['buildIndex'],
  budget: 1024,
  languages: ['typescript', 'python'],
  tokenCounter: value => value.length,
  cache: new Map(),
};
const result: Promise<RepoMapResult> = buildRepoMap('.', options);
void result;
