import { describe, expect, test } from "vitest";
import { checkRunbooks, type RunbookDocs, type RunbookRegistry } from "./runbooks";
// Imported up front: the module graph (Resend, OpenTelemetry, zod) can take longer to load on a
// busy runner than a test may run.
import { repoProblems } from "./runbooks-repo";

const SECTIONS = ["Trigger", "Impact", "Diagnose", "Mitigate", "Verify", "Record"];

function runbook(title: string, sections: string[] = SECTIONS, extra = ""): string {
  return [`# ${title}`, ...sections.map((s) => `## ${s}\n\nText.`), extra].join("\n\n");
}

const registry: RunbookRegistry = {
  opsAlerts: { "uptime-down": { runbook: "uptime-down.md" } },
  externalAlerts: { "nightly-failure": { runbook: "nightly-failure.md" } },
  procedures: ["rotate-secret.md"],
  insights: [{ id: "lcp-p75", runbook: "uptime-down.md" }],
};

function docs(
  overrides: Record<string, string | null> = {},
  repoFiles: string[] = [],
): RunbookDocs {
  const files: Record<string, string> = {
    "_template.md": runbook("Title"),
    "uptime-down.md": runbook("Uptime down"),
    "nightly-failure.md": runbook("Nightly failure"),
    "rotate-secret.md": runbook("Rotate"),
  };
  for (const [name, content] of Object.entries(overrides)) {
    if (content === null) delete files[name];
    else files[name] = content;
  }
  return {
    files: Object.keys(files).filter((f) => f !== "_template.md"),
    read: (name) => files[name] ?? "",
    exists: (path) => repoFiles.includes(path),
    template: files["_template.md"] ?? "",
  };
}

describe("checkRunbooks", () => {
  test("a consistent set passes", () => {
    expect(checkRunbooks(docs(), registry)).toEqual([]);
  });

  test("a kind without its file fails", () => {
    expect(checkRunbooks(docs({ "uptime-down.md": null }), registry)).toContain(
      "uptime-down: missing docs/runbooks/uptime-down.md",
    );
  });

  test("an external alert without its file fails", () => {
    expect(checkRunbooks(docs({ "nightly-failure.md": null }), registry)).toContain(
      "nightly-failure: missing docs/runbooks/nightly-failure.md",
    );
  });

  test("a posthog insight without its file fails", () => {
    const reg = { ...registry, insights: [{ id: "lcp-p75", runbook: "gone.md" }] };
    expect(checkRunbooks(docs(), reg)).toContain("lcp-p75: missing docs/runbooks/gone.md");
  });

  test("an insight without a runbook fails", () => {
    const reg = { ...registry, insights: [{ id: "lcp-p75" }] };
    expect(checkRunbooks(docs(), reg)).toContain("lcp-p75: no runbook");
  });

  test("an orphan runbook fails", () => {
    expect(checkRunbooks(docs({ "stray.md": runbook("Stray") }), registry)).toContain(
      "stray.md: no alert or procedure",
    );
  });

  test("a procedure passes without an alert", () => {
    expect(checkRunbooks(docs(), registry)).not.toContain(
      "rotate-secret.md: no alert or procedure",
    );
  });

  test("a procedure without its file fails", () => {
    expect(checkRunbooks(docs({ "rotate-secret.md": null }), registry)).toContain(
      "rotate-secret.md: missing docs/runbooks/rotate-secret.md",
    );
  });

  test.each(SECTIONS)("a runbook without ## %s fails", (section) => {
    const without = SECTIONS.filter((s) => s !== section);
    expect(
      checkRunbooks(docs({ "uptime-down.md": runbook("Uptime", without) }), registry),
    ).toContain(`uptime-down.md: missing section ## ${section}`);
  });

  test("sections out of order fail", () => {
    const swapped = [...SECTIONS];
    [swapped[0], swapped[1]] = [swapped[1] as string, swapped[0] as string];
    expect(
      checkRunbooks(docs({ "uptime-down.md": runbook("Uptime", swapped) }), registry),
    ).toContain(
      "uptime-down.md: sections out of order, expected Trigger, Impact, Diagnose, Mitigate, Verify, Record",
    );
  });

  test("extra sections after the template ones pass", () => {
    const extra = runbook("Rotate", [...SECTIONS, "Inventory"]);
    expect(checkRunbooks(docs({ "rotate-secret.md": extra }), registry)).toEqual([]);
  });

  test("a section heading inside a code block does not count", () => {
    const fenced = `# T\n\n\`\`\`md\n${SECTIONS.map((s) => `## ${s}`).join("\n")}\n\`\`\`\n`;
    const problems = checkRunbooks(docs({ "uptime-down.md": fenced }), registry);
    expect(problems).toContain("uptime-down.md: missing section ## Trigger");
  });

  test("a link to a runbook that does not exist fails", () => {
    const linked = runbook("Uptime", SECTIONS, "See [other](./gone.md).");
    expect(checkRunbooks(docs({ "uptime-down.md": linked }), registry)).toContain(
      "uptime-down.md: links runbook that does not exist: ./gone.md",
    );
  });

  test("a link to an existing runbook passes", () => {
    const linked = runbook("Uptime", SECTIONS, "See [other](nightly-failure.md#verify).");
    expect(checkRunbooks(docs({ "uptime-down.md": linked }), registry)).toEqual([]);
  });

  test("a broken relative link fails and a valid one passes", () => {
    const linked = runbook(
      "Uptime",
      SECTIONS,
      "[a](../../packages/x.ts) [b](../../packages/missing.ts)",
    );
    const problems = checkRunbooks(docs({ "uptime-down.md": linked }, ["packages/x.ts"]), registry);
    expect(problems).toEqual(["uptime-down.md: broken link: ../../packages/missing.ts"]);
  });

  test("external and anchor links are not checked", () => {
    const linked = runbook(
      "Uptime",
      SECTIONS,
      "[a](https://example.com/x) [b](#verify) [c](mailto:a@b.co)",
    );
    expect(checkRunbooks(docs({ "uptime-down.md": linked }), registry)).toEqual([]);
  });

  test("links inside code blocks are ignored", () => {
    const linked = runbook("Uptime", SECTIONS, "```\n[a](./gone.md)\n```");
    expect(checkRunbooks(docs({ "uptime-down.md": linked }), registry)).toEqual([]);
  });

  test("a template without sections fails loudly", () => {
    const d = { ...docs(), template: "# empty" };
    expect(checkRunbooks(d, registry)).toContain("_template.md: no sections");
  });
});

describe("the repository", () => {
  test("its runbooks pass the check", () => {
    expect(repoProblems()).toEqual([]);
  });
});
