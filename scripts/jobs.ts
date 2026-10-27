import { runJobs } from "../lib/jobs";

const result = await runJobs();
console.log(result.summary);
process.exit(0);
