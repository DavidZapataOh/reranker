import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { launchEnv } from "../env";
import { httpError } from "../providers/source-error";
import { type CheckResult, verdict } from "./types";

// https://docs.github.com/en/rest/repos/repos#get-a-repository. A transferred repository answers
// with a redirect to its new owner, which fetch follows.
const REPO = "https://api.github.com/repos/DavidZapataOh/reranker";
const API_VERSION = "2026-03-10";

const env = launchEnv.pick({ GITHUB_REPO_READ_TOKEN: true });
const Repo = z.object({ private: z.boolean(), owner: z.object({ type: z.string() }) });

/**
 * The repository is private and owned by an organization, so the anti-abuse thresholds and the
 * runbooks stop being public. Without a token a private repository answers 404, which says nothing.
 */
export async function checkGitHubRepo(signal?: AbortSignal): Promise<CheckResult> {
  const token = defineEnv([env]).GITHUB_REPO_READ_TOKEN;
  const response = await fetch(REPO, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(signal && { signal }),
  });
  if (!response.ok) throw httpError(response);
  const repo = Repo.parse(await response.json());
  const problems: string[] = [];
  if (!repo.private) problems.push("el repositorio es público");
  if (repo.owner.type !== "Organization") {
    problems.push("es de una cuenta personal, no de una organización");
  }
  return verdict("github-private-org", problems, "repositorio privado de una organización");
}
