import type { Encounter, Observation, Patient, Quantity, Reference, CodeableConcept, Resource } from '@medplum/fhirtypes';

// Les types FHIR R4 sont ceux de @medplum/fhirtypes (Apache-2.0), réexportés pour n'avoir qu'un import.
export type { Patient, Encounter, Observation, Reference, Quantity, CodeableConcept, Resource } from '@medplum/fhirtypes';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  /** Chemin FHIRPath, ex. `Patient.name[0]`. */
  path: string;
  message: string;
}
export interface ValidationResult { valid: boolean; issues: ValidationIssue[] }
export function validatePatient(resource: unknown): ValidationResult;
export function validateEncounter(resource: unknown): ValidationResult;
export function validateObservation(resource: unknown): ValidationResult;
/** Patient, Encounter ou Observation ; tout autre type est refusé (`not-supported`). */
export function validateResource(resource: unknown): ValidationResult;

export function createReference(resource: Pick<Resource, 'resourceType' | 'id'>, display?: string): Reference;
export interface ParsedReference { resourceType: string; id: string; versionId: string | null; absolute: boolean }
export function parseReference(reference: string | Reference | undefined | null): ParsedReference | null;
export function isReferenceTo(reference: string | Reference | undefined | null, resourceType: string): boolean;

export type VitalSign = 'bodyWeight' | 'bodyHeight' | 'heartRate' | 'bodyTemperature' | 'oxygenSaturation' | 'systolicBloodPressure' | 'diastolicBloodPressure';
export const VITAL_SIGNS: Readonly<Record<VitalSign, { code: string; display: string; unit: string; ucum: string }>>;
export function quantity(value: number, unit: string, code?: string): Quantity;
export function buildPatient(input?: {
  id?: string; family?: string; given?: string | string[]; gender?: 'male' | 'female' | 'other' | 'unknown';
  birthDate?: string; phone?: string; email?: string; identifier?: { system?: string; value: string }; active?: boolean;
}): Patient;
export function buildEncounter(input?: {
  id?: string; status?: Encounter['status']; classCode?: 'AMB' | 'IMP' | 'EMER' | 'VR'; subject?: Reference; start?: string; end?: string;
}): Encounter;
export function buildObservation(input?: {
  id?: string; status?: Observation['status']; vital?: VitalSign; code?: CodeableConcept;
  value?: number; subject?: Reference; encounter?: Reference; effective?: string;
}): Observation;
