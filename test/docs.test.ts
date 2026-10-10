import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { Express } from 'express';
import { openApiDocument } from '../src/docs/openapi.js';

let app: Express;

beforeAll(async () => {
  const { connectDb } = await import('../src/db/connect.js');
  await connectDb(process.env.TEST_MONGO_URI);
  const { createApp } = await import('../src/app.js');
  app = createApp();
});

afterAll(async () => {
  const { disconnectDb } = await import('../src/db/connect.js');
  await disconnectDb();
});

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3 document', async () => {
    await expect(SwaggerParser.validate(structuredClone(openApiDocument) as any)).resolves.toBeTruthy();
  });

  it('is served as JSON and as Swagger UI', async () => {
    const json = await request(app).get('/api/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.info.title).toBe('Tourista Rwanda API');
    const ui = await request(app).get('/api/docs/').redirects(1);
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
    expect((await request(app).get('/api/docs/swagger-ui-init.js')).status).toBe(200);
  });

  it('documents only routes that exist', async () => {
    const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
    const missing: string[] = [];
    for (const [path, item] of Object.entries(openApiDocument.paths as Record<string, any>)) {
      for (const method of methods) {
        if (!item[method]) continue;
        const res = await (request(app) as any)[method](`/api${path.replace(/\{[^}]+\}/g, 'x')}`).send({});
        if (res.body?.message === 'That endpoint was not found.') missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('describes request bodies from the validation schemas', () => {
    const schemas = openApiDocument.components.schemas as Record<string, any>;
    expect(schemas.BookingInput.properties.people.maximum).toBe(30);
    expect(schemas.LocationInput.properties.category.enum).toContain('National Park');
    expect(schemas.RegisterInput.properties.role.enum).toEqual(['tourist', 'business_owner']);
  });
});
