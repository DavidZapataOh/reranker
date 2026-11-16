import { posix } from "node:path";

const DIR = "docs/runbooks";

export type RunbookRegistry = {
  opsAlerts: Record<string, { runbook: string }>;
  externalAlerts: Record<string, { runbook: string }>;
  procedures: readonly string[];
  /** PostHog insight alerts from `posthog-alerts.json`. */
  insights: readonly { id: string; runbook?: string }[];
};

export type RunbookDocs = {
  /** Runbook file names in `docs/runbooks`, without the template. */
  files: readonly string[];
  read: (file: string) => string;
  /** Whether a repository-relative path exists. */
  exists: (path: string) => boolean;
  template: string;
};

function outsideFences(markdown: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) lines.push(line);
  }
  return lines;
}

function sections(markdown: string): string[] {
  return outsideFences(markdown).flatMap((line) => {
    const match = /^## (.+?)\s*$/.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
}

function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const line of outsideFences(markdown)) {
    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      if (match[1]) targets.push(match[1]);
    }
  }
  return targets;
}

function isLocal(target: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target);
}

function checkLinks(file: string, docs: RunbookDocs): string[] {
  const problems: string[] = [];
  for (const target of linkTargets(docs.read(file)).filter(isLocal)) {
    const path = posix.normalize(posix.join(DIR, target.split("#")[0] ?? ""));
    const sibling = posix.dirname(path) === DIR && path.endsWith(".md");
    if (sibling) {
      if (!docs.files.includes(posix.basename(path))) {
        problems.push(`${file}: links runbook that does not exist: ${target}`);
      }
    } else if (!docs.exists(path)) {
      problems.push(`${file}: broken link: ${target}`);
    }
  }
  return problems;
}

/**
 * Problems that keep the runbooks from covering the alerts: a runbook an alert names that is
 * missing, a runbook nothing refers to, a file without the template's sections, or a broken link.
 */
export function checkRunbooks(docs: RunbookDocs, registry: RunbookRegistry): string[] {
  const problems: string[] = [];
  const expected = sections(docs.template);
  if (expected.length === 0) return ["_template.md: no sections"];

  const referenced = new Set<string>();
  const need = (name: string, runbook: string | undefined) => {
    if (!runbook) {
      problems.push(`${name}: no runbook`);
      return;
    }
    referenced.add(runbook);
    if (!docs.files.includes(runbook)) problems.push(`${name}: missing ${DIR}/${runbook}`);
  };
  for (const [kind, alert] of Object.entries(registry.opsAlerts)) need(kind, alert.runbook);
  for (const [kind, alert] of Object.entries(registry.externalAlerts)) need(kind, alert.runbook);
  for (const insight of registry.insights) need(insight.id, insight.runbook);
  for (const procedure of registry.procedures) need(procedure, procedure);

  for (const file of docs.files) {
    if (!referenced.has(file)) problems.push(`${file}: no alert or procedure`);
    const found = sections(docs.read(file));
    for (const section of expected) {
      if (!found.includes(section)) problems.push(`${file}: missing section ## ${section}`);
    }
    const present = found.filter((s) => expected.includes(s));
    const inOrder = expected.filter((s) => present.includes(s));
    if (present.length === inOrder.length && present.some((s, i) => s !== inOrder[i])) {
      problems.push(`${file}: sections out of order, expected ${expected.join(", ")}`);
    }
    problems.push(...checkLinks(file, docs));
  }
  return problems;
}
