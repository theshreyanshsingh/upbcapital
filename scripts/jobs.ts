import { runJobs } from "../lib/jobs";

// No top-level await: the package is CommonJS, so tsx compiles this file to cjs, which cannot hold one.
runJobs()
  .then((result) => {
    console.log(result.summary);
    // A failed job fails the run, so the scheduler shows it.
    process.exit(result.failed.length ? 1 : 0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
