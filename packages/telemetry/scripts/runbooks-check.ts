import { repoProblems } from "../src/runbooks-repo";

const problems = repoProblems();
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log("runbooks: ok");
