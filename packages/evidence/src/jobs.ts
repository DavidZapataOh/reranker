import { defineJob } from "@reranker/jobs";

/** Appends every pending entry of `origin` to the transparency log and signs a checkpoint. */
export const integrateJob = defineJob<{ origin: string }>({
  name: "evidence.integrate",
  // Sealing queues this job before the integrator ships; failing keeps the entries pending, and
  // the first integration after it appends them all.
  handler: async () => {
    throw new Error("The transparency log integrator is not available in this deployment");
  },
});
