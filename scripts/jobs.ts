import { runJobs } from "../lib/jobs";

// No top-level await: the package is CommonJS, so tsx compiles this file to cjs, which cannot hold one.
runJobs()
  .then((result) => {
    console.log(result.summary);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
