import { countriesOfRegion, TAXONOMY_VERSION } from '@aptamind/taxonomy';
import { jobInterpretationInputSchema, jobInterpretationSchema } from '../contracts/employment';
import type { JobInterpretation, JobInterpretationInput } from '../contracts/employment';
import { interpretAuthorization } from './authorization';
import { interpretEmploymentType } from './employment-type';
import { normalizeLocations } from './locations';
import { interpretRelocation } from './relocation';
import { interpretRemoteScope } from './remote-scope';
import { extractRequirements } from './requirements';
import { extractResponsibilities } from './responsibilities';
import { interpretCompensation } from './salary';
import { interpretSponsorship } from './sponsorship';
import { unique } from './text';
import { interpretTitle } from './title';
import { interpretWorkModel } from './work-model';

/**
 * Deterministic job interpretation (no I/O, no AI, no clock): the same input always yields the
 * same output. Bump the logic version on any behavioural change to rules/parsers and the policy
 * version when a precedence/classification policy changes (context doc §25.4).
 */
export const INTERPRETATION_LOGIC_VERSION = 'job-interpretation-rules/2026-09-30.8';
/**
 * Countries where the work may be performed, from an interpretation: listed locations plus
 * remote-scope countries and regions, minus exclusions (as the interpreter computes them).
 */
export function workCountriesOf(interp: Pick<JobInterpretation, 'locations' | 'remoteScope'>): string[] {
  const scope = interp.remoteScope.value;
  return unique([
    ...interp.locations.map((l) => l.country).filter((c): c is string => !!c),
    ...scope.countries,
    ...scope.regions.flatMap((r) => countriesOfRegion(r)),
  ]).filter((c) => !scope.excludedCountries.includes(c));
}

export const INTERPRETATION_POLICY_VERSION = 'employment-policy/2026-09-30.8';

export function interpretJob(rawInput: JobInterpretationInput): JobInterpretation {
  const input = jobInterpretationInputSchema.parse(rawInput);
  const description = input.descriptionText;
  const provider = input.provider;

  const title = interpretTitle(input.title, provider.department);
  const employment = interpretEmploymentType(input.title, description, provider.employmentTypeText);
  const locations = normalizeLocations(input.locationTexts);

  const work = interpretWorkModel({
    title: input.title,
    description,
    locationTexts: input.locationTexts,
    locations,
    providerWorkplaceType: provider.workplaceType ?? null,
  });
  const scope = interpretRemoteScope({
    workModel: work.workModel.value,
    workModelConfidence: work.workModel.confidence,
    workModelEvidence: work.workModel.evidence,
    title: input.title,
    description,
    locationTexts: input.locationTexts,
    locations,
  });

  const locationCountries = unique(locations.map((l) => l.country).filter((c): c is string => !!c));
  const scopeValue = scope.remoteScope.value;
  // Countries where the work may be performed: listed locations plus remote-scope countries/regions.
  const workCountries = unique([
    ...locationCountries,
    ...scopeValue.countries,
    ...scopeValue.regions.flatMap((r) => countriesOfRegion(r)),
  ]).filter((c) => !scopeValue.excludedCountries.includes(c));

  const authorization = interpretAuthorization(description);
  const auth = authorization.value;
  // Sponsorship statements are read from ONE canonical rendering (a720377 (1)).
  const statements = input.statementSource ?? {
    rendering: 'description_text' as const,
    text: description,
    layoutLineStarts: [],
  };
  const sponsorship = interpretSponsorship({
    description: statements.text,
    rendering: statements.rendering,
    title: input.title,
    locationTexts: input.locationTexts,
    company: input.company,
    jobCountries: workCountries,
    rightToWork: { required: auth.required, countries: auth.countries, regions: auth.regions },
    layoutLineStarts: statements.layoutLineStarts,
  });
  const relocation = interpretRelocation(description);
  const compensation = interpretCompensation({
    description,
    provider: provider.compensation ?? null,
    // Only concrete countries resolve shared currency symbols; a region is too broad for "$".
    hints: {
      countries: unique([...locationCountries, ...scopeValue.countries]),
      employmentType: employment.employmentType.value,
    },
  });

  const result: JobInterpretation = {
    title,
    employmentType: employment.employmentType,
    locations,
    workModel: work.workModel,
    remoteScope: scope.remoteScope,
    officeAttendance: work.officeAttendance,
    sponsorship: sponsorship.sponsorship,
    authorization,
    relocation,
    compensation: compensation.compensation,
    requirements: extractRequirements(description),
    responsibilities: extractResponsibilities(description),
    flags: [...employment.flags, ...work.flags, ...scope.flags, ...sponsorship.flags, ...compensation.flags],
    logicVersion: INTERPRETATION_LOGIC_VERSION,
    policyVersion: INTERPRETATION_POLICY_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
  };
  return jobInterpretationSchema.parse(result);
}
