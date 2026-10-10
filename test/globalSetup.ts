import { existsSync } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const LOCAL_MONGOD = `${process.env.HOME}/mongodb-macos-x86_64-8.0.4/bin/mongod`;
let replSet: MongoMemoryReplSet | undefined;

export async function setup() {
  // Prefer an already-installed mongod so tests never need to download a binary.
  if (!process.env.MONGOMS_SYSTEM_BINARY && existsSync(LOCAL_MONGOD)) process.env.MONGOMS_SYSTEM_BINARY = LOCAL_MONGOD;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.TEST_MONGO_URI = replSet.getUri('tourista_test');
}

export async function teardown() {
  await replSet?.stop();
}
