import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractLearningRule,
  learnedPolicyPath,
  appendLearnedRule
} from "../packages/zcode-tui/src/auto-permissions.ts";

describe("policy learning from dialog answers", () => {
  test("extracts an addRules allow rule from an Always-allow response", () => {
    const response = {
      decision: "allow",
      reason: "Approved for this project",
      permissionUpdates: [
        { behavior: "allow", type: "addRules", rules: [{ toolName: "Write", ruleContent: "other.txt" }] }
      ]
    };
    expect(extractLearningRule(response)).toEqual({
      tool: "Write",
      ruleContent: "other.txt",
      behavior: "allow"
    });
  });

  test("returns null for plain allow/deny responses and non-addRules updates", () => {
    expect(extractLearningRule({ decision: "allow", reason: "x" })).toBeNull();
    expect(extractLearningRule({ decision: "deny" })).toBeNull();
    expect(extractLearningRule(null)).toBeNull();
    expect(extractLearningRule(undefined)).toBeNull();
    expect(extractLearningRule({
      decision: "allow",
      permissionUpdates: [{ type: "removeRules", rules: [{ toolName: "Write" }] }]
    })).toBeNull();
    expect(extractLearningRule({
      decision: "allow",
      permissionUpdates: [{ type: "addRules", rules: [] }]
    })).toBeNull();
  });

  test("learnedPolicyPath is project-local under .zcode", () => {
    expect(learnedPolicyPath("/repo")).toBe(join("/repo", ".zcode", "auto-permissions.json"));
  });

  test("appendLearnedRule creates the project policy file and adds the rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-learn-"));
    const rule = { tool: "Write", ruleContent: "other.txt", behavior: "allow" as const };
    const path = appendLearnedRule(dir, rule);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.defaults.unmatched).toBe("ask");
    expect(parsed.allow).toEqual([{ tool: "Write", pathPrefix: "other.txt", note: "learned from dialog" }]);
  });

  test("appendLearnedRule merges without duplicating existing rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-learn-"));
    const rule = { tool: "Write", ruleContent: "other.txt", behavior: "allow" as const };
    appendLearnedRule(dir, rule);
    appendLearnedRule(dir, rule);
    const parsed = JSON.parse(readFileSync(learnedPolicyPath(dir), "utf8"));
    expect(parsed.allow.length).toBe(1);
  });

  test("appendLearnedRule preserves existing custom rules in the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-learn-"));
    const zcodeDir = join(dir, ".zcode");
    mkdirSync(zcodeDir, { recursive: true });
    writeFileSync(learnedPolicyPath(dir), JSON.stringify({
      defaults: { unmatched: "deny" },
      allow: [{ tool: "Bash", commandPrefix: "npm test" }],
      softDeny: [],
      hardDeny: []
    }));
    appendLearnedRule(dir, { tool: "Write", ruleContent: "other.txt", behavior: "allow" });
    const parsed = JSON.parse(readFileSync(learnedPolicyPath(dir), "utf8"));
    expect(parsed.defaults.unmatched).toBe("deny");
    expect(parsed.allow).toContainEqual({ tool: "Bash", commandPrefix: "npm test" });
    expect(parsed.allow).toContainEqual({ tool: "Write", pathPrefix: "other.txt", note: "learned from dialog" });
  });

  test("appendLearnedRule never writes deny learnings as allow rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "zc-learn-"));
    appendLearnedRule(dir, { tool: "Bash", ruleContent: "cargo build", behavior: "deny" });
    const parsed = JSON.parse(readFileSync(learnedPolicyPath(dir), "utf8"));
    expect(parsed.allow).toEqual([]);
    expect(parsed.softDeny).toEqual([{ tool: "Bash", commandRegex: "cargo build", note: "learned from dialog" }]);
  });
});
