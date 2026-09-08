import type { ToolLedger } from "./tool-ledger";

/**
 * Operations for which an assistant must have matching, successful tool
 * evidence before it can make a strong completion claim.
 */
export type CompletionAction =
  | "deploy"
  | "fix"
  | "install"
  | "verify"
  | "upload"
  | "delete"
  | "create"
  | "configure"
  | "start"
  | "complete";

export type CompletionEvidenceStatus = "success" | "failure" | "unknown" | "pending";
export type OperationalAction = Exclude<CompletionAction, "complete">;

/**
 * A deliberately small structural type. ToolLedger is assignable to this
 * interface, while tests and future protocol adapters can provide an already
 * reduced ledger without coupling to a particular request format.
 */
export interface CompletionEvidenceRecord {
  name?: string;
  arguments?: unknown;
  normalizedArguments?: string;
  /** Sanitized action labels restored from a prior Responses turn. */
  operationHints?: readonly OperationalAction[];
  result?: unknown;
  failed?: boolean;
  status?: Exclude<CompletionEvidenceStatus, "pending">;
}

export interface CompletionEvidenceLedger {
  completed: readonly CompletionEvidenceRecord[];
  pending?: readonly CompletionEvidenceRecord[];
}

export interface CompletionActionEvidence {
  latest: CompletionEvidenceStatus;
  successes: number;
  failures: number;
  unknown: number;
  pending: number;
}

/**
 * Sanitized evidence only. It intentionally contains no tool name, arguments,
 * output, call ID, error text, path, token, URL, or other potentially sensitive
 * material and is therefore safe to retain in request-local diagnostics.
 */
export interface CompletionEvidenceSummary {
  actions: Partial<Record<Exclude<CompletionAction, "complete">, CompletionActionEvidence>>;
  successfulTools: number;
  failedTools: number;
  unknownTools: number;
  pendingTools: number;
  classifiedSuccessfulTools: number;
  classifiedFailedTools: number;
  unclassifiedFailedTools: number;
  unclassifiedUnknownTools: number;
}

/**
 * A Code Mode cell can perform a mutation and then read the exact result back
 * in the same caller-local program.  The ordinary action classifier keeps a
 * passive read unclassified on purpose; this marker is only used when the
 * read is a later, statically declared operation in the same cell.
 */
export interface ClassifiedEvidenceActions {
  actions: OperationalAction[];
  orderedVerificationAfterMutation: boolean;
}

export type CompletionEvidenceReason =
  | "no_completion_claim"
  | "supported"
  | "pending_evidence"
  | "failed_evidence"
  | "unknown_evidence"
  | "missing_evidence";

export interface CompletionEvidenceDecision {
  allowed: boolean;
  /**
   * `terminate` is used when a matching call is pending or failed. `downgrade`
   * replaces an unsupported success assertion with an honest, non-success
   * terminal response instead of asking the client to retry the same tool.
   */
  disposition: "allow" | "downgrade" | "terminate";
  reason: CompletionEvidenceReason;
  claimedActions: CompletionAction[];
  unsupportedActions: CompletionAction[];
  /** Fixed text only; it never interpolates raw evidence. */
  replacementText?: string;
}

const operationalActions: readonly OperationalAction[] = [
  "deploy",
  "fix",
  "install",
  "verify",
  "upload",
  "delete",
  "create",
  "configure",
  "start",
];

const failureSignal = /(?:exit\s*(?:code|status)?\s*[:=]?\s*[1-9]\d*|\berror\b|\bfailed\b|\bfailure\b|exception|traceback|timed?\s*out|timeout|permission denied|not found|refused|cancel(?:led|ed)|operation was canceled|\u9519\u8bef|\u5931\u8d25|\u8d85\u65f6|\u62d2\u7edd|\u65e0\u6743\u9650|\u627e\u4e0d\u5230|\u4e0d\u5b58\u5728|\u5df2\u53d6\u6d88)/iu;
const processExitSignal = /(?:^|\n)Process exited with code\s+(-?\d+)(?:\s|$)/iu;
const codeModeCompletionWrapper = /^\s*Script completed(?:\r?\n|\s*$)/iu;

/** Tool names are declared protocol metadata. They may identify an operation,
 * but their opaque arguments may contain arbitrary source files, patches, or
 * user data and therefore must not be searched as prose. */
const toolNamePatterns: Readonly<Record<OperationalAction, readonly RegExp[]>> = {
  deploy: [
    /(?:^|[_-])(?:deploy|deployment|release)(?:$|[_-])/iu,
  ],
  fix: [
    /(?:^|[_-])(?:fix|repair|patch)(?:$|[_-])/iu,
  ],
  install: [
    /(?:^|[_-])(?:install|installer|setup)(?:$|[_-])/iu,
  ],
  verify: [
    // A passive read/view/stat tool proves only that bytes were inspected. It
    // cannot establish that validation passed, so those names are excluded.
    /(?:^|[_-])(?:verify|validate|validation|tests?|checks?|healthcheck|doctor|audit|inspect)(?:$|[_-])/iu,
  ],
  upload: [
    /(?:^|[_-])(?:upload|publish|push|sync)(?:$|[_-])/iu,
  ],
  delete: [
    /(?:^|[_-])(?:delete|remove|cleanup|clean|purge)(?:$|[_-])/iu,
  ],
  create: [
    /(?:^|[_-])(?:create|provision|scaffold|mkdir)(?:$|[_-])/iu,
  ],
  configure: [
    /(?:^|[_-])(?:configure|config|edit|update|modify|save)(?:$|[_-])/iu,
    /(?:^|[_-])write(?:$|[_-](?:file|content|config|settings))/iu,
  ],
  start: [
    /(?:^|[_-])(?:start|restart|launch|run_service)(?:$|[_-])/iu,
  ],
};

/** Commands are caller-local operational metadata, but their string operands
 * can still be opaque file/code payloads. Match only explicit command shapes;
 * never generic prose words such as health, checks, remove, or start. */
const commandPatterns: Readonly<Record<OperationalAction, readonly RegExp[]>> = {
  deploy: [
    /\bwrangler\s+deploy\b/iu,
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?deploy\b/iu,
    /\bkubectl\s+(?:apply|rollout)\b/iu,
    /\bdocker(?:\s+compose|\s+stack)?\s+(?:up|deploy)\b/iu,
  ],
  fix: [
    /\bapply[_-]?patch\b/iu,
  ],
  install: [
    /\b(?:apt(?:-get)?|dnf|yum|pip\d*|npm|pnpm|yarn|winget|choco)\s+install\b/iu,
  ],
  verify: [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:s)?\b/iu,
    /\b(?:go|cargo|dotnet|deno)\s+test\b/iu,
    /\b(?:pytest|vitest|jest|mocha|ava|ctest)\b/iu,
    /\b(?:mvn|gradle|gradlew)\b[^\r\n;&|]{0,100}\btest\b/iu,
    /\btsc\b[^\r\n;&|]{0,160}\b--noEmit\b/iu,
    /\bnode\b[^\r\n;&|]{0,160}\b--check\b/iu,
    /\b(?:eslint|stylelint|html-validate)\b/iu,
  ],
  upload: [
    /\bgit\s+push\b/iu,
    /\b(?:scp|rsync|rclone)\b/iu,
    /\baws\s+s3\s+(?:cp|sync)\b/iu,
  ],
  delete: [
    /(?:^|[;&|\s])rm\s+(?:-[^\s]+\s+)*(?:--\s+)?[^\s]/iu,
    /\bRemove-Item\b/iu,
  ],
  create: [
    /(?:^|[;&|\s])mkdir(?:\s|$)/iu,
    /\bNew-Item\b/iu,
  ],
  configure: [
    /\b(?:Set-Content|Add-Content)\b/iu,
  ],
  start: [
    /\bsystemctl\s+(?:start|restart|reload)\b/iu,
    /\bStart-(?:Service|Process)\b/iu,
  ],
};

const claimPatterns: Readonly<Record<CompletionAction, readonly RegExp[]>> = {
  deploy: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5b8c\u6210)?\s*(?:\u90e8\u7f72|\u4e0a\u7ebf)/giu,
    /(?:\u90e8\u7f72|\u4e0a\u7ebf)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?deployed\b/giu,
    /\bdeployment\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
    /\b(?:is|went)\s+live\b/giu,
  ],
  fix: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5f7b\u5e95)?\s*(?:\u4fee\u590d|\u89e3\u51b3)/giu,
    /(?:\u4fee\u590d|\u6574\u6539)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:fixed|repaired|resolved)\b/giu,
    /\b(?:fix|repair|remediation)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  install: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*\u5b89\u88c5/giu,
    /\u5b89\u88c5(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?installed\b/giu,
    /\binstallation\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  verify: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5)/giu,
    /(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u901a\u8fc7|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?verified\b/giu,
    /\b(?:verification|validation|tests?|checks?)\s+(?:(?:is|are|was|were|has\s+been|have\s+been)\s+)?(?:complete|completed|successful|passed)\b/giu,
  ],
  upload: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)/giu,
    /(?:\u4e0a\u4f20|\u53d1\u5e03|\u63a8\u9001|\u540c\u6b65)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:uploaded|published|pushed|synced)\b/giu,
    /\b(?:upload|publication|push|sync)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  delete: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)/giu,
    /(?:\u5220\u9664|\u79fb\u9664|\u6e05\u7406)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:deleted|removed|cleaned|purged)\b/giu,
    /\b(?:deletion|removal|cleanup)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  create: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u521b\u5efa|\u65b0\u5efa)/giu,
    /(?:\u521b\u5efa|\u65b0\u5efa)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?created\b/giu,
    /\bcreation\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  configure: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u4fdd\u5b58)/giu,
    /(?:\u914d\u7f6e|\u4fee\u6539|\u66f4\u65b0|\u5199\u5165|\u4fdd\u5b58)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:configured|updated|modified|written|saved)\b/giu,
    /\b(?:configuration|update|modification)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  start: [
    /(?:\u5df2(?:\u7ecf)?|\u6210\u529f(?:\u5730)?)\s*(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)/giu,
    /(?:\u542f\u52a8|\u91cd\u542f|\u91cd\u8f7d)(?:\u5de5\u4f5c)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5b8c\u6210|\u6210\u529f|\u5b8c\u6bd5)/giu,
    /\b(?:successfully\s+)?(?:started|restarted|launched|reloaded)\b/giu,
    /\b(?:startup|restart|launch|reload)\s+(?:(?:is|was|has\s+been)\s+)?(?:complete|completed|successful)\b/giu,
  ],
  complete: [
    /(?:\u5168\u90e8|\u6240\u6709|\u6574\u4e2a|\u672c\u6b21)?\s*(?:\u4efb\u52a1|\u5de5\u4f5c|\u5904\u7406|\u64cd\u4f5c|\u6267\u884c|\u6574\u6539)\s*(?:\u5747|\u90fd)?\s*(?:\u5df2(?:\u7ecf)?)?\s*(?:\u5168\u90e8)?\s*(?:\u5b8c\u6210|\u5b8c\u6bd5)/giu,
    /(?:\u5168\u90e8|\u6240\u6709)\s*(?:\u90fd|\u5df2)?\s*(?:\u5b8c\u6210|\u5b8c\u6bd5)/giu,
    /\b(?:all\s+done|everything\s+(?:is\s+)?(?:done|complete)|task\s+(?:(?:is|was|has\s+been)\s+)?(?:done|complete|completed)|work\s+(?:(?:is|was|has\s+been)\s+)?(?:done|complete|completed)|completed\s+successfully)\b/giu,
  ],
};

function parsedOperationArguments(record: CompletionEvidenceRecord): unknown {
  const value = record.arguments ?? record.normalizedArguments ?? {};
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Free-form tools legitimately use non-JSON input.
    }
  }
  return value;
}

function operationRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedOperationName(name: unknown): string {
  const value = typeof name === "string" ? name.trim().toLowerCase() : "";
  return value.split(/[.:/\\]/u).at(-1) ?? value;
}

function patchInput(argumentsValue: unknown): string {
  if (typeof argumentsValue === "string") return argumentsValue.slice(0, 256_000);
  const record = operationRecord(argumentsValue);
  const value = record?.input ?? record?.patch;
  return typeof value === "string" ? value.slice(0, 256_000) : "";
}

function classifyPatchHeaders(input: string, actions: Set<OperationalAction>): void {
  // Only transport-level headers describe the patch operation. Added/deleted
  // source lines are opaque data and may contain arbitrary action vocabulary.
  for (const match of input.matchAll(/^\*\*\*\s+(Add File|Delete File|Update File|Move to):/gimu)) {
    const kind = match[1].toLowerCase();
    if (kind === "add file") actions.add("create");
    else if (kind === "delete file") actions.add("delete");
    else actions.add("configure");
  }
}

function decodeStaticStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try {
      const parsed = JSON.parse(literal) as unknown;
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (!literal.startsWith("'") || !literal.endsWith("'")) return "";
  const escapes: Readonly<Record<string, string>> = {
    "'": "'",
    '"': '"',
    "\\": "\\",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  return literal.slice(1, -1).replace(/\\(['"\\bfnrtv])/gu, (_whole, escaped: string) => escapes[escaped] ?? escaped);
}

function codeModeExecCommands(input: string): string[] {
  const commands: string[] = [];
  // Code Mode is opaque JavaScript except for a static first `cmd` property on
  // an actual caller-local exec_command invocation. Dynamic expressions and
  // strings elsewhere in the program deliberately provide no evidence.
  const call = /\btools\.exec_command\s*\(\s*\{\s*(?:["']cmd["']|cmd)\s*:\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/gimu;
  for (const match of input.slice(0, 256_000).matchAll(call)) {
    const decoded = decodeStaticStringLiteral(match[1]);
    if (decoded) commands.push(decoded);
  }
  return commands;
}

function commandTextWithoutOpaqueOperands(command: string): string {
  return command
    // PowerShell here-strings are normally used for file bodies.
    .replace(/@(["'])\r?\n[\s\S]*?\r?\n\1@/gu, " ")
    // Shell quoted operands are paths/data, not operation selectors. Commands
    // such as `node --check "app.js"` retain their meaningful unquoted tokens.
    .replace(/'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`/gu, " ")
    .slice(0, 16_384);
}

function trustedCommandTexts(name: string, argumentsValue: unknown): string[] {
  const record = operationRecord(argumentsValue);
  if (name === "exec") {
    const input = typeof record?.input === "string"
      ? record.input
      : typeof argumentsValue === "string" ? argumentsValue : "";
    return codeModeExecCommands(input);
  }
  if (!/(?:^|[_-])(?:exec|exec_command|command|shell|bash|powershell|terminal)(?:$|[_-])/iu.test(name)) return [];
  if (record) {
    return [record.cmd, record.command]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }
  return typeof argumentsValue === "string" ? [argumentsValue] : [];
}

function trustedSelectorTexts(argumentsValue: unknown): string[] {
  const record = operationRecord(argumentsValue);
  if (!record) return [];
  return [record.action, record.operation, record.mode, record.method]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.slice(0, 128));
}

function commandMatchesAction(command: string, action: OperationalAction): boolean {
  return commandPatterns[action].some((pattern) => pattern.test(command));
}

function isExplicitReadbackCommand(command: string): boolean {
  // These are narrow, caller-local read/compare forms.  Generic words such as
  // "check" or "verify" are deliberately excluded because they may be data.
  return /(?:^|[;&|\s])(?:Get-Content|Get-Item|Test-Path|Select-String|Compare-Object|type|cat)(?:\s|$)/iu.test(command)
    || /\b(?:git\s+diff\s+--check|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:s)?|(?:pytest|vitest|jest|mocha|ava)\b)/iu.test(command);
}

function isStaticFileCreationCommand(command: string): boolean {
  // Set-Content creates the target when it is absent and therefore proves a
  // file-presence/create outcome after a successful caller command.  Keep the
  // rule narrow: arbitrary redirection or prose must not become create
  // evidence, and the ordinary classifier still reports Set-Content as
  // configure for standalone calls.
  return /\bSet-Content\b[^\r\n;&|]{0,240}\s-(?:LiteralPath|Path)\b/iu.test(command);
}

export function completionEvidenceActions(record: CompletionEvidenceRecord): ClassifiedEvidenceActions {
  const actions = new Set<OperationalAction>(classifyCompletionActions(record));
  const hintedOrderedVerification = Boolean(
    record.operationHints?.includes("verify")
      && [...actions].some((action) => action !== "verify"),
  );
  const name = normalizedOperationName(record.name);
  if (name !== "exec") {
    return { actions: [...actions], orderedVerificationAfterMutation: hintedOrderedVerification };
  }
  const argumentsValue = parsedOperationArguments(record);
  const commands = trustedCommandTexts(name, argumentsValue).map(commandTextWithoutOpaqueOperands);
  let mutationSeen = false;
  let orderedVerificationAfterMutation = hintedOrderedVerification;
  for (const command of commands) {
    const commandActions = operationalActions.filter((action) => commandMatchesAction(command, action));
    if (commandActions.some((action) => action !== "verify")) mutationSeen = true;
    if (isStaticFileCreationCommand(command)) actions.add("create");
    // A later read-back is meaningful only after a mutation was declared in an
    // earlier static call.  The command source remains the authority; result
    // prose is never searched for action vocabulary.
    if (mutationSeen && isExplicitReadbackCommand(command)) {
      orderedVerificationAfterMutation = true;
      actions.add("verify");
    }
  }
  return { actions: [...actions], orderedVerificationAfterMutation };
}

export function classifyCompletionActions(record: CompletionEvidenceRecord): OperationalAction[] {
  const actions = new Set<OperationalAction>();
  for (const hint of record.operationHints ?? []) {
    if (operationalActions.includes(hint)) actions.add(hint);
  }

  const name = normalizedOperationName(record.name);
  const argumentsValue = parsedOperationArguments(record);
  const selectors = trustedSelectorTexts(argumentsValue);
  for (const action of operationalActions) {
    if (toolNamePatterns[action].some((pattern) => pattern.test(name))) actions.add(action);
    if (selectors.some((selector) => toolNamePatterns[action].some((pattern) => pattern.test(selector)))) actions.add(action);
  }

  if (name === "apply_patch" || name === "applypatch") {
    actions.add("fix");
    classifyPatchHeaders(patchInput(argumentsValue), actions);
  }

  for (const command of trustedCommandTexts(name, argumentsValue)) {
    const controlText = commandTextWithoutOpaqueOperands(command);
    for (const action of operationalActions) {
      if (commandPatterns[action].some((pattern) => pattern.test(controlText))) actions.add(action);
    }
  }
  return [...actions];
}

function compactResultText(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 4_096);
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result).slice(0, 4_096);
  } catch {
    return "";
  }
}

function normalizedStatusText(result: unknown): string {
  return compactResultText(result)
    .replace(/&(?:#x0*20|#0*32|nbsp);/giu, " ")
    .replace(/\r\n?/gu, "\n");
}

function structuredResultStatus(result: unknown): Exclude<CompletionEvidenceStatus, "pending"> | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw === 0 ? "success" : "failure";
    if (typeof raw === "string" && /^-?\d+$/u.test(raw.trim())) return Number(raw) === 0 ? "success" : "failure";
  }
  for (const key of ["is_error", "isError", "failed"] as const) {
    if (typeof value[key] === "boolean") return value[key] ? "failure" : "success";
  }
  if (typeof value.success === "boolean") return value.success ? "success" : "failure";
  return null;
}

function evidenceStatus(record: CompletionEvidenceRecord): Exclude<CompletionEvidenceStatus, "pending"> {
  if (record.status) return record.status;
  if (record.failed === true) return "failure";
  const structured = structuredResultStatus(record.result);
  if (structured) return structured;
  const result = normalizedStatusText(record.result);
  if (!result.trim()) return "unknown";
  const processExit = processExitSignal.exec(result.slice(0, 1_024));
  if (processExit) return Number(processExit[1]) === 0 ? "success" : "failure";
  // `Script completed` is the Code Mode wrapper's status, not the status of
  // nested exec_command calls. Without a child exit code it cannot authorize
  // a completion claim, even when older adapters supplied `failed: false`.
  if (normalizedOperationName(record.name) === "exec" && codeModeCompletionWrapper.test(result)) {
    return failureSignal.test(result) ? "failure" : "unknown";
  }
  if (record.failed === false) return "success";
  return failureSignal.test(result) ? "failure" : "success";
}

function emptyActionEvidence(status: CompletionEvidenceStatus): CompletionActionEvidence {
  return {
    latest: status,
    successes: 0,
    failures: 0,
    unknown: 0,
    pending: 0,
  };
}

function updateActionEvidence(
  actions: Partial<Record<OperationalAction, CompletionActionEvidence>>,
  action: OperationalAction,
  status: CompletionEvidenceStatus,
): void {
  const evidence = actions[action] ?? emptyActionEvidence(status);
  evidence.latest = status;
  if (status === "success") evidence.successes += 1;
  else if (status === "failure") evidence.failures += 1;
  else if (status === "unknown") evidence.unknown += 1;
  else evidence.pending += 1;
  actions[action] = evidence;
}

function invalidatesPriorVerification(actions: readonly OperationalAction[]): boolean {
  return actions.some((action) => action !== "verify");
}

function updateOrderedActionEvidence(
  summary: CompletionEvidenceSummary,
  actions: readonly OperationalAction[],
  status: CompletionEvidenceStatus,
  orderedVerificationAfterMutation = false,
): void {
  const invalidatesVerification = invalidatesPriorVerification(actions);
  if (invalidatesVerification) delete summary.actions.verify;
  for (const action of actions) {
    // A combined mutation-and-check command is deliberately not accepted as a
    // post-mutation validator: the sanitized ledger cannot prove their inner
    // order. A separate later validator produces fresh verification evidence.
    if (action === "verify" && invalidatesVerification && !orderedVerificationAfterMutation) continue;
    updateActionEvidence(summary.actions, action, status);
  }
}

/** Reduces a full ledger to non-sensitive action/status counters. */
export function summarizeCompletionEvidence(
  ledger: CompletionEvidenceLedger | Pick<ToolLedger, "completed" | "pending">,
): CompletionEvidenceSummary {
  const summary: CompletionEvidenceSummary = {
    actions: {},
    successfulTools: 0,
    failedTools: 0,
    unknownTools: 0,
    pendingTools: ledger.pending?.length ?? 0,
    classifiedSuccessfulTools: 0,
    classifiedFailedTools: 0,
    unclassifiedFailedTools: 0,
    unclassifiedUnknownTools: 0,
  };

  for (const record of ledger.completed) {
    const status = evidenceStatus(record);
    if (status === "success") summary.successfulTools += 1;
    else if (status === "failure") summary.failedTools += 1;
    else summary.unknownTools += 1;

    const classified = completionEvidenceActions(record);
    const actions = classified.actions;
    if (status === "success" && actions.length > 0) summary.classifiedSuccessfulTools += 1;
    if (status === "failure" && actions.length > 0) summary.classifiedFailedTools += 1;
    if (status === "failure" && actions.length === 0) summary.unclassifiedFailedTools += 1;
    if (status === "unknown" && actions.length === 0) summary.unclassifiedUnknownTools += 1;
    updateOrderedActionEvidence(summary, actions, status, classified.orderedVerificationAfterMutation);
  }

  for (const record of ledger.pending ?? []) {
    const classified = completionEvidenceActions(record);
    updateOrderedActionEvidence(summary, classified.actions, "pending", classified.orderedVerificationAfterMutation);
  }

  return summary;
}

function clauseBefore(text: string, index: number): string {
  const prefix = text.slice(Math.max(0, index - 80), index);
  const boundary = Math.max(prefix.lastIndexOf("，"), prefix.lastIndexOf(","), prefix.lastIndexOf("；"), prefix.lastIndexOf(";"));
  return prefix.slice(boundary + 1);
}

function isNonAssertiveContext(text: string, start: number, end: number): boolean {
  const before = clauseBefore(text, start);
  const after = text.slice(end, Math.min(text.length, end + 18));

  // Negation must be close to the matched phrase. This covers "not deployed",
  // "cannot confirm it was installed", and Chinese equivalents without making
  // an unrelated earlier negative clause suppress a real assertion.
  if (/(?:\u5c1a\u672a|\u8fd8\u672a|\u5e76\u672a|\u6ca1\u6709|\u6ca1\u80fd|\u672a\u80fd|\u65e0\u6cd5|\u4e0d\u80fd|\u4e0d\u66fe|\u5e76\u975e|\u4e0d\u53ef|\u4e0d\u786e\u5b9a|\u4e0d\u80fd\u786e\u8ba4)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,14}$/iu.test(before)) return true;
  if (/\b(?:not|never|cannot|can't|unable\s+to|failed\s+to|didn't|hasn't|haven't|wasn't|isn't|cannot\s+confirm|can't\s+confirm)\b[^,.!?;]{0,20}$/iu.test(before)) return true;

  // Plans, requirements, hypotheticals and preconditions are not claims that
  // an operation has actually happened.
  if (/(?:\u5982\u679c|\u82e5|\u5047\u5982|\u4e00\u65e6|\u53ea\u6709|\u9664\u975e|\u5f85|\u7b49\u5230|\u5c06|\u4f1a|\u51c6\u5907|\u8ba1\u5212|\u6253\u7b97|\u9700\u8981|\u5fc5\u987b|\u53ef\u4ee5|\u5e94\u5f53)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,30}$/u.test(before)) return true;
  if (/\b(?:if|when|once|unless|provided|assuming|will|would|could|should|can|may|might|plan(?:s|ned)?\s+to|intend(?:s|ed)?\s+to|need(?:s|ed)?\s+to|going\s+to|must)\b[^,.!?;]{0,35}$/iu.test(before)) return true;
  if (/^\s*(?:\u540e|\u4e4b\u540e|\u65f6|\u4ee5\u540e|\u518d|\u624d|after\b|before\b|once\b|if\b|when\b)/iu.test(after)) return true;

  // Quoted event/field names and "how it works" descriptions are prose about
  // a completion state, not assertions that the state was reached.
  if (/(?:\u540d\u4e3a|\u53eb\u4f5c|\u5b57\u6bb5|\u4e8b\u4ef6|\u5b57\u7b26\u4e32|\u672f\u8bed|\u8bf4\u660e|\u63cf\u8ff0|\u89e3\u91ca)[^\uff0c,\u3002.!?\uff01\uff1f\uff1b;]{0,16}[\u201c\u2018"']?$/u.test(before)
    && /^[\u201d\u2019"']?(?:\u4e8b\u4ef6|\u72b6\u6001|\u5b57\u6bb5|\u6d88\u606f|\u6d41\u7a0b|\u7684\u542b\u4e49|\u5982\u4f55|\u65f6)/u.test(after)) return true;
  if (/[\u201c\u2018"']\s*$/u.test(before)
    && /^[\u201d\u2019"'](?:\u4e8b\u4ef6|\u72b6\u6001|\u5b57\u6bb5|\u6d88\u606f|\u6d41\u7a0b|\u7684\u542b\u4e49)/u.test(after)) return true;
  if (/\b(?:called|named|phrase|term|event|field|message|explains?\s+how|describes?\s+how)\b[^,.!?;]{0,24}[\u201c\u2018"']?$/iu.test(before)
    && /^[\u201d\u2019"']?\s*(?:event|status|field|message|flow|means|works?)\b/iu.test(after)) return true;

  return false;
}

/** Finds strong operational completion claims, while excluding plans and denials. */
export function completionClaims(answer: string): CompletionAction[] {
  const claims = new Set<CompletionAction>();
  for (const action of [...operationalActions, "complete" as const]) {
    for (const pattern of claimPatterns[action]) {
      pattern.lastIndex = 0;
      for (const match of answer.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (!isNonAssertiveContext(answer, start, start + match[0].length)) claims.add(action);
      }
    }
  }
  // "completed successfully" frequently overlaps a specific phrase such as
  // "deployment completed successfully". In that sentence `complete` adds no
  // independent all-task assertion; evaluate the specific operation only.
  if (claims.size > 1) claims.delete("complete");
  return [...claims];
}

function replacementText(reason: CompletionEvidenceReason): string {
  if (reason === "pending_evidence") {
    return "当前仍有工具调用未返回，无法确认相关操作已完成。请先等待或检查最后一次工具结果。";
  }
  if (reason === "failed_evidence") {
    return "现有工具证据显示相关操作失败或未成功完成，因此不能声明已经完成。请检查最后一次失败结果后再决定下一步。";
  }
  if (reason === "unknown_evidence") {
    return "工具结果的状态无法核验，因此不能确认相关操作已经完成。";
  }
  return "没有与该完成声明对应的成功工具证据，因此暂时无法确认相关操作已经完成。";
}

function genericCompletionSupported(summary: CompletionEvidenceSummary): CompletionEvidenceReason {
  if (summary.pendingTools > 0) return "pending_evidence";
  if (summary.unclassifiedFailedTools > 0) return "failed_evidence";
  if (summary.unclassifiedUnknownTools > 0) return "unknown_evidence";
  if (summary.classifiedSuccessfulTools === 0) {
    if (summary.failedTools > 0) return "failed_evidence";
    if (summary.unknownTools > 0 || summary.successfulTools > 0) return "unknown_evidence";
    return "missing_evidence";
  }
  // A passive read/view/stat can support a precise verification claim, but it
  // cannot by itself prove that an entire multi-step task is complete.
  const successfulNonVerificationAction = Object.entries(summary.actions).some(([action, state]) => (
    action !== "verify" && state?.latest === "success"
  ));
  if (!successfulNonVerificationAction) return "unknown_evidence";
  for (const state of Object.values(summary.actions)) {
    if (state?.latest === "failure") return "failed_evidence";
    if (state?.latest === "unknown") return "unknown_evidence";
    if (state?.latest === "pending") return "pending_evidence";
  }
  return "supported";
}

/**
 * Evaluates the assistant's final prose against a sanitized evidence summary.
 * Every distinct asserted operation must be supported. One successful tool does
 * not authorize unrelated claims, and a later success only repairs failure for
 * the same classified operation.
 */
export function evaluateCompletionEvidence(
  answer: string,
  ledgerOrSummary: CompletionEvidenceLedger | Pick<ToolLedger, "completed" | "pending"> | CompletionEvidenceSummary,
): CompletionEvidenceDecision {
  const claims = completionClaims(answer);
  if (claims.length === 0) {
    return {
      allowed: true,
      disposition: "allow",
      reason: "no_completion_claim",
      claimedActions: [],
      unsupportedActions: [],
    };
  }

  const summary = "successfulTools" in ledgerOrSummary
    ? ledgerOrSummary
    : summarizeCompletionEvidence(ledgerOrSummary);
  const reasons = new Map<CompletionAction, CompletionEvidenceReason>();

  for (const claim of claims) {
    if (claim === "complete") {
      reasons.set(claim, genericCompletionSupported(summary));
      continue;
    }
    // An outstanding tool makes any strong terminal assertion unsafe, even if
    // its operation cannot be classified yet.
    if (summary.pendingTools > 0) {
      reasons.set(claim, "pending_evidence");
      continue;
    }
    const state = summary.actions[claim];
    if (!state) reasons.set(claim, "missing_evidence");
    else if (state.latest === "success") reasons.set(claim, "supported");
    else if (state.latest === "failure") reasons.set(claim, "failed_evidence");
    else if (state.latest === "unknown") reasons.set(claim, "unknown_evidence");
    else reasons.set(claim, "pending_evidence");
  }

  const unsupportedActions = claims.filter((claim) => reasons.get(claim) !== "supported");
  if (unsupportedActions.length === 0) {
    return {
      allowed: true,
      disposition: "allow",
      reason: "supported",
      claimedActions: claims,
      unsupportedActions: [],
    };
  }

  const unsupportedReasons = unsupportedActions.map((claim) => reasons.get(claim));
  const reason: CompletionEvidenceReason = unsupportedReasons.includes("pending_evidence")
    ? "pending_evidence"
    : unsupportedReasons.includes("failed_evidence")
      ? "failed_evidence"
      : unsupportedReasons.includes("unknown_evidence")
        ? "unknown_evidence"
        : "missing_evidence";
  return {
    allowed: false,
    disposition: reason === "pending_evidence" || reason === "failed_evidence" ? "terminate" : "downgrade",
    reason,
    claimedActions: claims,
    unsupportedActions,
    replacementText: replacementText(reason),
  };
}
