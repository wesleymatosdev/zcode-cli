// Auto permission classifier: a middle permission tier between "ask for
// everything" (build) and "bypass everything" (yolo).
//
// Inspired by Claude Code's `auto` permission mode. Classification happens in
// the TUI layer, at the seam where the runtime's permission request would
// otherwise render a dialog: allow/deny verdicts return the same response
// objects the dialog produces ({ decision, reason, permissionUpdates }), and
// unmatched requests return null so the normal human dialog runs.
//
// The classifier is fail-open toward the dialog by design: any internal
// error, missing config, or unmatched request defers to the user. It can
// never widen yolo mode (it only runs when a prompt would show) and cannot
// override runtime-side explicit deny rules (those never reach a prompt).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { asString, isRecord } from "./types.ts"

export interface AutoPermissionRule {
  tool: string | string[]
  commandPrefix?: string
  commandRegex?: string
  pathPrefix?: string
  pathRegex?: string
  note?: string
}

export interface AutoPermissionConfig {
  defaults: { unmatched: "ask" | "allow" | "deny" }
  allow: AutoPermissionRule[]
  softDeny: AutoPermissionRule[]
  hardDeny: AutoPermissionRule[]
}

export interface PermissionRequestShape {
  toolName: string
  input: unknown
  riskLevel?: string
}

export interface AutoPermissionVerdict {
  behavior: "allow" | "deny"
  reason: string
  matchedRule: AutoPermissionRule
}

// Paths that carry credentials. Never auto-approved; denied outright when a
// hardDeny rule targets them.
const secretPathPattern = String.raw`(^|[/\\])\.(env|ssh|aws|gnupg|kube|netrc|npmrc)([/\\]|$)|\.pem$|id_rsa|credentials`

function ruleToBuiltin(rule: Omit<AutoPermissionRule, "note">, note: string): AutoPermissionRule {
  return { ...rule, note }
}

export function builtinAutoPermissionConfig(): AutoPermissionConfig {
  const readOnlyCommands = [
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "rg",
    "grep",
    "find",
    "which",
    "file",
    "stat"
  ]
  return {
    defaults: { unmatched: "ask" },
    allow: [
      ...readOnlyCommands.map((command) => ruleToBuiltin({ tool: "Bash", commandPrefix: command }, "read-only command")),
      ruleToBuiltin({ tool: ["Read", "Glob", "Grep", "TodoRead", "WebSearch"] }, "read-only tool")
    ],
    softDeny: [
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\bgit\s+reset\s+--hard\b` }, "history rewrite of working tree")
    ],
    hardDeny: [
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r` }, "recursive force delete"),
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\bsudo\s` }, "privilege escalation"),
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\b(curl|wget)\b[^|;&]*\|\s*(ba|z|fi)?sh\b` }, "remote code piped to shell"),
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\bgit\s+push\b[^;&]*--force` }, "force push"),
      ruleToBuiltin({ tool: ["Read", "Write", "Edit"], pathRegex: secretPathPattern }, "credential path"),
      ruleToBuiltin({ tool: "Bash", commandRegex: secretPathPattern }, "credential path in command")
    ]
  }
}

function readConfigFile(configPath: string, base: AutoPermissionConfig): AutoPermissionConfig {
  try {
    if (!existsSync(configPath)) return base
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
    if (!isRecord(parsed)) return base
    const defaults = isRecord(parsed.defaults) ? parsed.defaults : {}
    const unmatched = defaults.unmatched === "allow" || defaults.unmatched === "deny" || defaults.unmatched === "ask"
      ? defaults.unmatched
      : base.defaults.unmatched
    const rules = (key: "allow" | "softDeny" | "hardDeny"): AutoPermissionRule[] => {
      const value = parsed[key]
      if (!Array.isArray(value)) return base[key]
      return value.flatMap((entry): AutoPermissionRule[] => {
        if (!isRecord(entry)) return []
        const tool = asString(entry.tool) ?? (Array.isArray(entry.tool) ? entry.tool.filter((item): item is string => typeof item === "string") : undefined)
        if (!tool) return []
        return [{
          tool,
          commandPrefix: asString(entry.commandPrefix),
          commandRegex: asString(entry.commandRegex),
          pathPrefix: asString(entry.pathPrefix),
          pathRegex: asString(entry.pathRegex),
          note: asString(entry.note)
        }]
      })
    }
    return {
      defaults: { unmatched },
      // File rules layer on top of built-ins: learned/custom rules can add
      // to the base policy, and the built-ins always stay active.
      allow: [...base.allow, ...rules("allow")],
      softDeny: [...base.softDeny, ...rules("softDeny")],
      hardDeny: [...base.hardDeny, ...rules("hardDeny")]
    }
  } catch {
    // A broken config file must never break the TUI: fall back to the input.
    return base
  }
}

// Load order (later layers add rules on top of earlier ones):
//   built-ins → <project>/.zcode/auto-permissions.json (learned rules)
//   → ZCODE_AUTO_PERMISSIONS_CONFIG (explicit user override)
export function loadAutoPermissionConfig(configPath: string | undefined, projectRoot?: string): AutoPermissionConfig {
  let config = builtinAutoPermissionConfig()
  if (projectRoot) config = readConfigFile(learnedPolicyPath(projectRoot), config)
  if (configPath) config = readConfigFile(configPath, config)
  return config
}

// The full layered policy the overlay should evaluate: built-ins + learned
// file + explicit env override, in one config.
export function effectiveAutoPermissionConfig(projectRoot: string | undefined, envConfigPath: string | undefined): AutoPermissionConfig {
  return loadAutoPermissionConfig(envConfigPath, projectRoot)
}

function commandOf(input: unknown): string {
  if (!isRecord(input)) return ""
  return asString(input.command) ?? ""
}

function pathOf(input: unknown): string {
  if (!isRecord(input)) return ""
  return asString(input.file_path) ?? asString(input.path) ?? ""
}

function prefixMatches(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false
  if (value.length === prefix.length) return true
  return /[\s/]/u.test(value[prefix.length])
}

function ruleMatches(rule: AutoPermissionRule, request: PermissionRequestShape): boolean {
  const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool]
  if (!tools.includes(request.toolName)) return false
  const command = commandOf(request.input)
  const path = pathOf(request.input)
  if (rule.commandPrefix !== undefined && !prefixMatches(command, rule.commandPrefix)) return false
  if (rule.commandRegex !== undefined && !new RegExp(rule.commandRegex, "u").test(command)) return false
  if (rule.pathPrefix !== undefined && !prefixMatches(path, rule.pathPrefix)) return false
  if (rule.pathRegex !== undefined && !new RegExp(rule.pathRegex, "u").test(path)) return false
  return true
}

function firstMatch(rules: AutoPermissionRule[], request: PermissionRequestShape): AutoPermissionRule | undefined {
  return rules.find((rule) => ruleMatches(rule, request))
}

function describeRule(rule: AutoPermissionRule): string {
  if (rule.note) return rule.note
  if (rule.commandPrefix) return rule.commandPrefix
  if (rule.pathPrefix) return rule.pathPrefix
  const pattern = rule.commandRegex ?? rule.pathRegex
  if (pattern) return `pattern match (${pattern})`
  return "rule"
}

export function classifyPermissionRequest(
  request: PermissionRequestShape,
  config: AutoPermissionConfig
): AutoPermissionVerdict | null {
  const hardDeny = firstMatch(config.hardDeny, request)
  if (hardDeny) return { behavior: "deny", reason: `auto-permissions: ${describeRule(hardDeny)}`, matchedRule: hardDeny }
  const allowed = firstMatch(config.allow, request)
  if (allowed) return { behavior: "allow", reason: `auto-permissions: ${describeRule(allowed)} (${request.toolName})`, matchedRule: allowed }
  const softDeny = firstMatch(config.softDeny, request)
  if (softDeny) return { behavior: "deny", reason: `auto-permissions: ${describeRule(softDeny)}`, matchedRule: softDeny }
  switch (config.defaults.unmatched) {
    case "allow":
      return { behavior: "allow", reason: "auto-permissions: defaults.unmatched=allow", matchedRule: { tool: request.toolName, note: "defaults.unmatched=allow" } }
    case "deny":
      return { behavior: "deny", reason: "auto-permissions: defaults.unmatched=deny", matchedRule: { tool: request.toolName, note: "defaults.unmatched=deny" } }
    default:
      return null
  }
}

// ---- learning: mirror "Always allow" dialog answers into the policy file ----
//
// The dialog's "Always allow in this project" choice returns the runtime's
// addRules payload. We mirror it into a project-local policy file
// (<cwd>/.zcode/auto-permissions.json) so learned rules are portable,
// diffable, and editable — and feed them back through the same classifier
// config the overlay already loads.

export interface LearnedRule {
  tool: string
  ruleContent?: string
  behavior: "allow" | "deny"
}

export function extractLearningRule(response: unknown): LearnedRule | null {
  if (!isRecord(response)) return null
  const updates = response.permissionUpdates
  if (!Array.isArray(updates)) return null
  for (const update of updates) {
    if (!isRecord(update) || update.type !== "addRules") continue
    const rules = update.rules
    if (!Array.isArray(rules) || rules.length === 0) continue
    const first = rules.find(isRecord)
    if (!first) continue
    const toolName = asString(first.toolName)
    if (!toolName) continue
    const ruleContent = asString(first.ruleContent)
    return {
      tool: toolName,
      ...(ruleContent ? { ruleContent } : {}),
      behavior: "allow"
    }
  }
  return null
}

export function learnedPolicyPath(projectRoot: string): string {
  return join(projectRoot, ".zcode", "auto-permissions.json")
}

function learnedRuleToPolicyRule(rule: LearnedRule): AutoPermissionRule {
  const base: AutoPermissionRule = { tool: rule.tool, note: "learned from dialog" }
  if (!rule.ruleContent) return base
  return rule.behavior === "allow"
    ? { ...base, pathPrefix: rule.ruleContent }
    : { ...base, commandRegex: escapeRegExp(rule.ruleContent) }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

export function appendLearnedRule(projectRoot: string, rule: LearnedRule): string {
  const path = learnedPolicyPath(projectRoot)
  // The learned file is a sparse overlay: it stores only learned rules so it
  // stays small, diffable, and does not pin stale copies of the built-ins
  // (which the loader always layers underneath).
  let allow: AutoPermissionRule[] = []
  let softDeny: AutoPermissionRule[] = []
  let hardDeny: AutoPermissionRule[] = []
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (isRecord(parsed)) {
        if (Array.isArray(parsed.allow)) allow = parsed.allow as AutoPermissionRule[]
        if (Array.isArray(parsed.softDeny)) softDeny = parsed.softDeny as AutoPermissionRule[]
        if (Array.isArray(parsed.hardDeny)) hardDeny = parsed.hardDeny as AutoPermissionRule[]
      }
    }
  } catch {
    // Unreadable file: start from a fresh overlay rather than clobbering blindly.
  }
  const target = rule.behavior === "allow" ? allow : softDeny
  const candidate = learnedRuleToPolicyRule(rule)
  const duplicate = target.some((existing) => JSON.stringify(existing) === JSON.stringify(candidate))
  if (!duplicate) target.push(candidate)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({
    defaults: { unmatched: existingUnmatched(path, allow, softDeny, hardDeny) },
    allow,
    softDeny,
    hardDeny
  }, null, 2)}\n`)
  return path
}

function existingUnmatched(
  path: string,
  allow: AutoPermissionRule[],
  softDeny: AutoPermissionRule[],
  hardDeny: AutoPermissionRule[]
): "ask" | "allow" | "deny" {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (isRecord(parsed) && isRecord(parsed.defaults)) {
      const value = parsed.defaults.unmatched
      if (value === "ask" || value === "allow" || value === "deny") return value
    }
  } catch {
    // Fall through to the default below.
  }
  void allow
  void softDeny
  void hardDeny
  return "ask"
}


// Auto classification is opt-in: it runs only in the client's auto overlay
// mode, and only for ordinary tool-permission prompts. AskUserQuestion and
// plan approval are human decisions by design and are never auto-answered.
export function shouldAutoClassify(mode: string | undefined, toolName: string): boolean {
  if (mode !== "auto") return false
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/gu, "")
  return normalized !== "askuserquestion" && normalized !== "exitplanmode" && normalized !== "exitplanmodev2"
}

// The exact response object shape the permission dialog returns to the
// runtime (see defaultPermissionChoices / requestToolPermission). A null
// verdict means "no auto decision": the caller renders the human dialog.
export type PermissionDialogResponse = { decision: "allow" | "deny"; reason: string }

export function autoPermissionResponse(
  request: PermissionRequestShape,
  config: AutoPermissionConfig
): PermissionDialogResponse | null {
  const verdict = classifyPermissionRequest(request, config)
  if (!verdict) return null
  return { decision: verdict.behavior, reason: verdict.reason }
}
