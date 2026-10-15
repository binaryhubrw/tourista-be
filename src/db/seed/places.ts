import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Location } from '../../models/index.js';
import { slugify } from '../../utils/ids.js';
import { connectDb, disconnectDb } from '../connect.js';

interface Place {
  name: string;
  district: string;
  province: string;
  coordinates: { lat: number; lng: number };
}

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'places.json');

/** Stable id so a deploy can run this seed again without duplicating a place. */
function placeId(place: Place) {
  return place.name === place.district
    ? `district-${slugify(place.name)}`
    : `place-${slugify(place.name)}-${slugify(place.district)}`;
}

/**
 * Upserts districts and towns only. Leaves every other collection, and any
 * location an admin already created under the same name and district, alone.
 */
export async function seedPlaces() {
  const places = JSON.parse(readFileSync(file, 'utf8')) as Place[];
  const existing = await Location.find({}, { name: 1, district: 1 }).lean<any[]>();
  const taken = new Map(existing.map((row) => [`${row.name}\0${row.district}`, String(row._id)]));
  const createdAt = new Date().toISOString().slice(0, 10);
  const ops = [];
  for (const place of places) {
    const id = placeId(place);
    const other = taken.get(`${place.name}\0${place.district}`);
    if (other && other !== id) continue;
    const city = place.province === 'City of Kigali' && (place.name === place.district || place.name === 'Kigali');
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            name: place.name,
            district: place.district,
            province: place.province,
            coordinates: place.coordinates,
          },
          $setOnInsert: {
            category: city ? 'City' : 'Town',
            interests: [],
            shortDescription: '',
            description: '',
            image: '',
            gallery: [],
            rating: 0,
            reviewCount: 0,
            thingsToDo: [],
            sustainability: [],
            priceLevel: 1,
            isHiddenGem: false,
            isPopular: false,
            visitsLastYear: 0,
            createdAt,
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await Location.bulkWrite(ops);
  return { written: ops.length, skipped: places.length - ops.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  connectDb()
    .then(() => seedPlaces())
    .then(async (result) => {
      console.log('Location seed', result);
      await disconnectDb();
    })
    .catch(async (err) => {
      console.error(err);
      await disconnectDb();
      process.exit(1);
    });
}
