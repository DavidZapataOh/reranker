import { beforeEach, expect, test, vi } from "vitest";
import { FatalError } from "workflow";

// Without the workflow compiler the steps are plain functions, so the run calls them directly.
const jobs = vi.hoisted(() => ({
  registerJobStarter: vi.fn(),
  runJob: vi.fn(),
  runOpportunistic: vi.fn(async () => {}),
  reportStepError: vi.fn(async () => {}),
}));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  ...jobs,
}));
vi.mock("workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow")>()),
  getStepMetadata: () => ({ attempt: 2 }),
  sleep: vi.fn(async () => {}),
}));
vi.mock("./registry", () => ({ startJob: "start-job" }));

const { InvalidInputError } = await import("@reranker/jobs");
const { jobWorkflow } = await import("./run");

const JOB_ID = "0194f5c0-0000-7000-8000-000000000001";

beforeEach(() => vi.clearAllMocks());

test("a job that fails is reported under its name, then rethrown as a step error", async () => {
  const error = new InvalidInputError("payload");
  jobs.runJob.mockRejectedValue(error);
  await expect(jobWorkflow("report.email", { id: 1 }, null, JOB_ID)).rejects.toBeInstanceOf(
    FatalError,
  );
  expect(jobs.reportStepError).toHaveBeenCalledExactlyOnceWith("job", "report.email", error);
  expect(jobs.runOpportunistic).not.toHaveBeenCalled();
});

test("a job that succeeds reports nothing and gives opportunistic work a turn", async () => {
  jobs.runJob.mockResolvedValue(undefined);
  await jobWorkflow("report.email", { id: 1 }, null, JOB_ID);
  expect(jobs.runJob).toHaveBeenCalledWith("report.email", { id: 1 }, 2, JOB_ID);
  expect(jobs.reportStepError).not.toHaveBeenCalled();
  expect(jobs.runOpportunistic).toHaveBeenCalledOnce();
});
