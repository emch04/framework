'use strict';

const RESOURCE_TYPE = /^[A-Z][A-Za-z]+$/;
const ID = /^[A-Za-z0-9\-.]{1,64}$/;

/** `Patient/123` : référence relative littérale d'une ressource qui a un id. */
function createReference(resource, display) {
  if (!resource || !RESOURCE_TYPE.test(resource.resourceType ?? '')) throw new TypeError('RESOURCE_TYPE_REQUIRED');
  if (!ID.test(resource.id ?? '')) throw new TypeError('RESOURCE_ID_REQUIRED');
  return { reference: `${resource.resourceType}/${resource.id}`, ...(display ? { display } : {}) };
}

/**
 * Lit une référence : relative (`Patient/1`, `Patient/1/_history/2`) ou absolue
 * (`https://hote/fhir/Patient/1`). Les références internes (`#id`) et les URN
 * ne désignent pas une ressource adressable : `null`.
 */
function parseReference(reference) {
  const value = typeof reference === 'string' ? reference : reference?.reference;
  if (typeof value !== 'string' || !value || value.startsWith('#') || value.startsWith('urn:')) return null;
  const match = /(?:^|\/)([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([A-Za-z0-9\-.]{1,64}))?$/.exec(value);
  if (!match) return null;
  return { resourceType: match[1], id: match[2], versionId: match[3] ?? null, absolute: /^https?:\/\//.test(value) };
}

function isReferenceTo(reference, resourceType) {
  return parseReference(reference)?.resourceType === resourceType;
}

module.exports = { createReference, parseReference, isReferenceTo };
