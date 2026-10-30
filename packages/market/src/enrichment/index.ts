/**
 * Deterministic employment intelligence: HTML → text, and job interpretation (work model, remote
 * scope, sponsorship, authorisation, relocation, salary, requirements, responsibilities) with
 * evidence spans and confidence for every interpreted field.
 */
export { INTERPRETATION_LOGIC_VERSION, INTERPRETATION_POLICY_VERSION, interpretJob } from './interpret';
export { htmlToText } from './html';
export { interpretTitle, normalizeTitle } from './title';
export type { TitleInterpretation } from './title';
export { interpretEmploymentType } from './employment-type';
export type { EmploymentTypeResult } from './employment-type';
export { isRemoteLabel, normalizeLocation, normalizeLocations, splitLocationText } from './locations';
export { findWorkModelStatements, interpretWorkModel, workModelFromLabel } from './work-model';
export type {
  OfficeAttendance,
  WorkModel,
  WorkModelInput,
  WorkModelResult,
  WorkModelStatement,
} from './work-model';
export { findRemoteRestrictions, geoOf, interpretRemoteScope } from './remote-scope';
export type { RemoteScopeInput, RemoteScopeResult, RestrictionStatement } from './remote-scope';
export { findSponsorshipStatements, interpretSponsorship } from './sponsorship';
export type { SponsorshipInput, SponsorshipResult, SponsorshipStatement } from './sponsorship';
export { interpretAuthorization } from './authorization';
export type { Authorization } from './authorization';
export { interpretRelocation } from './relocation';
export type { RelocationStatus } from './relocation';
export {
  ANNUALIZATION,
  annualize,
  findSalaryText,
  interpretCompensation,
  normalizeSalary,
  parseAmount,
} from './salary';
export type {
  CompensationInput,
  CompensationResult,
  PayPeriod,
  SalaryHints,
  SalaryTextMatch,
} from './salary';
export { categorize, extractRequirements, parseYears } from './requirements';
export { extractResponsibilities, SCOPE_SIGNALS } from './responsibilities';
export type { Responsibilities } from './responsibilities';
export { classifyHeading, detectSections } from './sections';
export type { Section, SectionKind } from './sections';
export { locationFieldText, MAX_QUOTE_LENGTH, sentences, spanOf } from './text';
export type { Interpreted, InterpretationFlag, Segment } from './text';
export {
  checkInterpretationInvariants,
  evaluateInterpretationGolden,
  getPath,
  loadGoldenCases,
  matchExpectation,
} from './golden';
export type { GoldenCase, GoldenCaseResult, GoldenReport } from './golden';
