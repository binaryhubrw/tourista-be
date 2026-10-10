// Feeds the frontend's own demo records through the backend's input schemas, the way the FE would send them.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { locationInput } from '../src/modules/locations.routes.js';
import { experienceInput } from '../src/modules/experiences.routes.js';
import { businessInput } from '../src/modules/businesses.routes.js';
import { itineraryInput } from '../src/modules/itineraries.routes.js';
import { reviewInput } from '../src/modules/reviews.routes.js';
import { userInput } from '../src/modules/users.routes.js';

const load = (n: string): any[] => JSON.parse(readFileSync(new URL(`../src/db/seed/data/${n}.json`, import.meta.url), 'utf8'));
const issues = (schema: any, rows: any[]) =>
  rows.flatMap((r) => { const x = schema.safeParse(r); return x.success ? [] : [`${r.id ?? r.name}: ${x.error.issues.map((i: any) => `${i.path.join('.')} ${i.message}`).join('; ')}`]; });

describe('frontend records are accepted by the backend schemas', () => {
  it('locations', () => expect(issues(locationInput, load('locations'))).toEqual([]));
  it('experiences', () => expect(issues(experienceInput, load('experiences'))).toEqual([]));
  it('businesses (full object, as the listing editor sends it)', () => expect(issues(businessInput, load('businesses'))).toEqual([]));
  it('itineraries', () => expect(issues(itineraryInput, load('itineraries'))).toEqual([]));
  it('reviews', () => expect(issues(reviewInput, load('reviews'))).toEqual([]));
  it('users', () => expect(issues(userInput, load('users').map((u) => ({ ...u, password: undefined })))).toEqual([]));
});
