import { existsSync } from "node:fs";
import { formatEval, runEval } from "../lib/ai-eval";
import { activeReader, rulesReader } from "../lib/ai-reading";
import { prisma } from "../lib/prisma";

// Runs the document reader over the labelled files in tests/fixtures/ai-reading and records the score the desk's
// settings page gates ON on. It tests the reader the server would run: the model when a key is set, the rules
// reader otherwise. `--rules` tests the rules reader whatever the environment says.
if (existsSync(".env")) process.loadEnvFile(".env");

const reader = process.argv.includes("--rules") ? rulesReader() : activeReader();

runEval({ reader })
  .then(({ result }) => console.log(formatEval(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
