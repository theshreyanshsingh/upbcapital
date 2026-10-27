import { existsSync } from "node:fs";
import { assertMongoUrl } from "../lib/deploy";
import { syncIndexes } from "../lib/mongo-indexes";
import { prisma } from "../lib/prisma";

// MongoDB has no migrations. This builds the indexes the schema declares and is safe to run again.
if (existsSync(".env")) process.loadEnvFile(".env");

Promise.resolve()
  .then(() => assertMongoUrl(process.env.DATABASE_URL))
  .then(() => syncIndexes(prisma))
  .then((result) => console.log(`Indexes in sync: ${result.indexes} declared, ${result.created} created or rebuilt.`))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
