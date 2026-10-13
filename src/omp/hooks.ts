/**
 * Graft's omp (oh-my-pi) host adapter — the omp equivalent of src/claude/hooks.ts.
 *
 * Claude Code's hook runs as a spawned Node process fed lifecycle events on
 * stdin (SessionStart / UserPromptSubmit / PostToolUse / Stop). omp is
 * in-process: an extension binds `pi.on(...)` handlers to the same lifecycle
 * moments on the live event bus, so this adapter ports the four hooks
 * one-for-one, reusing every hook-side computation (retrieval scoring,
 * blast-radius formatting, stats bookkeeping, stale counting) unchanged.
 *
 * Where each piece of context lands:
 *   - SessionStart orientation + trail line → a custom message from
 *     `before_agent_start` (omp delivers trusted context for the turn there,
 *     not at session-start which runs before the session is wired).
 *   - Prompt retrieval pack → the same `before_agent_start` custom message.
 *   - Post-edit blast radius → `tool_result` returning `additionalContext`
 *     (trusted, delivered outside the tool result before the next request).
 *   - Post-tool savings tally → also `tool_result`, on non-edit tools.
 *   - Stop → detached sync spawn, identical to Claude's Stop hook.
 *
 * Handlers gate on `ctx.agent.kind === "main"`: task/subagent sessions never
 * inject context from a graph the task didn't ask for (the same posture Claude
 * Code applies via its subagent statusline block).
 */
import { basename, isAbsolute, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { readWiring } from "../claude/stats.js";
import { formatBlastRadius, relevantRetrieval, formatOrientation } from "../claude/format.js";
import { lastFileScopeHint } from "../claude/hooks.js";
import { indexFreshness, staleBanner } from "../context/check.js";
import { patchStats, readStats, readSession, writeSession, acquireLock, resolveContextDir } from "../claude/state.js";
import { recordToolUse, isMcpToolName, isGraftMcpTool, parseSavings } from "../claude/session-metrics.js";
import { runUpkeep } from "../upkeep-run.js";
import { runningVersion } from "../upkeep.js";
import { readLink } from "../brain/link.js";
import { pickedAgents } from "../brain/push.js";
import { readTrailSnapshot, trailContextLine } from "../brain/watch-trail.js";
import { maybeAutopush, readTrailPushState, recordSeenSuggestions } from "../brain/autopush.js";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Prompts shorter than this never trigger retrieval — conversational turns
 * ("yes go ahead", "thanks") can't be judged reliably with so few terms.
 * Same floor as src/claude/hooks.ts's `MIN_PROMPT_CHARS`. */
const MIN_PROMPT_CHARS = 12;

/** Budget for a `graft ask` child spawned by a handler. omp has no
 * settings.json timeout to read back like the Claude layer does, so one value
 * covers both the cold rebuild after an upgrade and warm runs — comfortably
 * inside omp's 30s handler budget either way. */
const CHILD_TIMEOUT_MS = 10_000;

/** Absolute path of this package's compiled CLI, resolved from this module. */
function cliPath(): string {
  return new URL("../cli.js", import.meta.url).pathname;
}

/** Absolute path of a sibling script in the compiled claude dir. */
function claudeScript(name: string): string {
  return new URL(`../claude/${name}`, import.meta.url).pathname;
}

/** Raw shape the compiled tool_result event carries — one of the ToolResult
 * union members. Only `input`, `toolName`, and `content` are read here, so the
 * adapter keeps a local structural type instead of importing the full union. */
interface ToolResultEventLike {
  type: "tool_result";
  toolName: string;
  input: Record<string, unknown>;
  content: unknown[];
}

/** Raw shape of a compiled before_agent_start event. Only `prompt` is read. */
interface BeforeAgentStartEventLike {
  type: "before_agent_start";
  prompt: string;
}

/** Raw shape of a compiled context event. Only `prompt` is read. */
interface SessionStartEventLike {
  type: "session_start";
}

/** Raw shape of a compiled agent_end event. Nothing is read from it today. */
interface AgentEndEventLike {
  type: "agent_end";
}

/** Subset of `ExtensionContext` these handlers actually read. The full omp
 * contract lives in @oh-my-pi/pi-coding-agent; this local structural table is
 * what a port of hooks.ts needs and keeps the submodule testable against the
 * compiled dist. */
interface ExtensionContextLike {
  agent: { kind: string; id?: string; name?: string };
  cwd: string;
  sessionManager?: { getSessionId?: () => unknown };
}

/**
 * Spawn a graft subcommand and parse stdout as JSON.
 *
 * Sync execution (`execFileSync`) IS the correct choice in omp's in-process
 * extension context (30s handler budget, race-free stats bookkeeping), unlike
 * the Claude hook's
 * spawned-process-and-emit-stdout shape. A cold `graft check` exits non-zero
 * while still printing valid JSON, so the recovery matches hooks.ts's
 * `graftJson` exactly.
 */
function ompGraftJson(
  dir: string,
  args: string[],
  timeout: number = CHILD_TIMEOUT_MS,
): unknown | null {
  try {
    const out = execFileSync(process.execPath, [cliPath(), ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  } catch (e) {
    // `graft check` exits non-zero when the graph is stale (by design) but still
    // prints valid JSON to stdout; recover it from the thrown error.
    const err = e as { stdout?: string } | null;
    if (err && typeof err.stdout === "string" && err.stdout.trim()) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* not JSON — fall through */
      }
    }
    return null;
  }
}

/** Thread `--dir` through the child argv when GRAFT_DIR is set. Same shape as
 * hooks.ts's `withContextDirArg`. */
function ompContextDirArg(dir: string, args: string[]): string[] {
  return process.env.GRAFT_DIR ? [...args, "--dir", resolveContextDir(dir)] : args;
}

/** A parsed JSON tree worth reading two specific buckets off. */
interface CheckJson {
  graph?: {
    changed?: unknown[];
    added?: unknown[];
    removed?: unknown[];
  };
}

/** Current-graph stale count, in the same shape as hooks.ts's `checkStaleCount`. */
function ompCheckStaleCount(dir: string): number {
  const r = ompGraftJson(dir, ompContextDirArg(dir, ["check", ".", "--json"]));
  const g = (r as CheckJson | null)?.graph ?? {};
  return (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
}

/** The file an edit tool touched, spanning omp's `edit`/`write` shapes.
 * Mirrors hooks.ts's `editedFilePath` but reads omp's event shape: the edit
 * event carries a `path`/`paths` field (see hooks.md's edit note). */
function ompEditedFilePath(input: Record<string, unknown>, dir: string): string | null {
  const direct = input.file_path ?? input.dst ?? input.path;
  if (typeof direct === "string" && direct.trim()) {
    return isAbsolute(direct) ? direct : join(dir, direct);
  }
  const paths = input.paths;
  if (Array.isArray(paths) && typeof paths[0] === "string" && paths[0].trim()) {
    return isAbsolute(paths[0]) ? paths[0] : join(dir, paths[0]);
  }
  return null;
}

/** Whether the touched file sits under the repo's `graft/` cache — edits there
 * are graft's own output, not user code, and never trigger the blast-radius or
 * sync machinery. Same shape as hooks.ts's `underGraft`. */
function underGraftDir(dir: string, file: string): boolean {
  const rel = file.startsWith(dir) ? file.slice(dir.length) : file;
  return rel.replace(/^[/\\]+/, "").replace(/\\/g, "/").startsWith("graft/");
}

/** Session-id shape omp handlers see: `ctx.sessionManager` owns it. */
function ompSessionKey(ctx: ExtensionContextLike): string {
  const id = ctx.sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : "default";
}

/** Post-edit blast-radius line, or null when there is nothing useful to say. */
function ompPostEditRadius(dir: string, file: string): string | null {
  const w = readWiring(dir);
  if (!w) return null;
  return formatBlastRadius(w, file);
}

/**
 * The prompt-retrieval pack: run `graft ask <prompt> --json -n 3`, score it,
 * and return the formatted pointers-only lines.
 *
 * No `--source`: per-prompt injected tokens are fresh full-price input on every
 * turn (unlike the cached session-start orientation), so the pack carries
 * locators the agent then pulls via `graft ask --source` when one looks right.
 * `relevantRetrieval` drops it when the prompt barely overlaps the top hit or
 * when every hit was already injected this session.
 */
function ompPromptPack(dir: string, prompt: string, sessionId: string): string | null {
  const askArgs = [...ompContextDirArg(dir, ["ask", prompt, ".", "--json", "-n", "3"])];
  const scopeHint = lastFileScopeHint(dir, readStats(dir)?.lastFile);
  if (scopeHint) askArgs.push("--in", scopeHint);
  const ask = ompGraftJson(dir, askArgs);
  if (!ask) return null;
  const s = readSession(dir, sessionId);
  const txt = relevantRetrieval(ask as never, s);
  writeSession(dir, sessionId, s); // lastQuery/perAgentQuery rides along even when the pack is dropped
  return txt;
}

/** Session-start trail line: 3s cap, network fenced to a repo with a trail.
 * In-process omp handlers can await this directly (unlike the Claude hook's
 * stdin round-trip), so the full capped flow ports over with no wrapper. */
async function ompTrailAtSessionStart(dir: string): Promise<string | null> {
  try {
    const link = readLink(dir);
    if (!link) return null;
    const capped = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(3000) })) as typeof fetch;
    maybeAutopush(dir);
    const result = await readTrailSnapshot(dir, link, pickedAgents(dir), capped);
    if (!result || !result.ok) return null;
    const lastSeen = readTrailPushState(dir).seenSuggested;
    if (result.snapshot.suggested !== null) recordSeenSuggestions(dir, result.snapshot.suggested);
    return trailContextLine(result.snapshot, lastSeen);
  } catch {
    return null; // a Trail that never answers must never crash the session
  }
}

/** One custom message from `before_agent_start`, as the compiled result shape
 * expects (`BeforeAgentStartEventResult.message?: CustomMessagePayload`). */
function ompSetupMessage(body: string): { message: { customType: string; content: string; display: true; attribution: "agent" } } {
  return {
    message: {
      customType: "graft:orientation",
      content: body,
      display: true,
      attribution: "agent",
    },
  };
}

/**
 * The omp extension factory — binds graft's work to omp's lifecycle events.
 *
 * The dispatch table mirrors hooks.ts's `main()`:
 *
 *   Claude Code hook      omp event            Role
 *   ----------------------  --------------------  ---------------------------
 *   SessionStart           session_start         cache the trail/orientation
 *   UserPromptSubmit       before_agent_start    pointers-only retrieval pack
 *   PostToolUse(Edit)      tool_result(Edit)     blast-radius additionalContext
 *   PostToolUse(query)     tool_result(Read/etc)   graft-read + savings tally
 *   PostToolUse(MCP-graft) tool_result(gr_*)     savings tally (no double count)
 *   Stop                   agent_end             detached sync spawn
 */
export default function (pi: ExtensionAPI): void {
  // Session-start lines (trail + upkeep + orientation) land at the first
  // `before_agent_start` of the session: omp fires session_start while the
  // session is still being wired, and before_agent_start is the moment the
  // turn's trusted context is delivered. Graft's opening context rides the
  // same dist-state record the Claude hook writes to, so the two hosts share
  // the counters.
  let opening: string | null = null;

  pi.on("session_start", async (_event: SessionStartEventLike, ctx: ExtensionContextLike) => {
    if (ctx.agent.kind !== "main") return;
    if (!existsSync(join(ctx.cwd, "graft"))) return; // no graph: the skill tells the agent to run `graft build`; no noise here
    try {
      const upkeep = runUpkeep(ctx.cwd, runningVersion(), { background: false }).lines;
      const trail = await ompTrailAtSessionStart(ctx.cwd);
      const lines = [...upkeep];
      if (trail) lines.push(trail);
      try {
        const idx = readFileSync(join(resolveContextDir(ctx.cwd), "INDEX.md"), "utf8");
        const banner = staleBanner(indexFreshness(ctx.cwd)) ?? undefined;
        lines.push(formatOrientation(idx, undefined, banner));
      } catch {
        // no INDEX.md (never built here) — the upkeep/trail lines stand alone
      }
      opening = lines.length ? lines.join("\n\n") : null;
    } catch (e) {
      console.error(`[graft] session-start hook: ${(e as Error)?.message ?? e}`);
    }
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEventLike, ctx: ExtensionContextLike) => {
    if (ctx.agent.kind !== "main") return undefined;
    const sessionId = ompSessionKey(ctx);
    const snippets: string[] = [];
    if (opening) {
      snippets.push(opening);
      opening = null; // the orientation mentions once, not on every turn
    }
    // No graph → no retrieval. The skip keeps a repo whose build failed from
    // paying the ask budget on every turn (hooks.ts's `prompt` branch gates on
    // the same existsSync shape via the earlier `hasGraftIndex` call).
    if (!existsSync(join(ctx.cwd, "graft"))) {
      return snippets.length ? ompSetupMessage(snippets.join("\n\n")) : undefined;
    }
    const prompt = String(event?.prompt ?? "").trim();
    if (prompt.length < MIN_PROMPT_CHARS) {
      return snippets.length ? ompSetupMessage(snippets.join("\n\n")) : undefined;
    }
    try {
      const pack = ompPromptPack(ctx.cwd, prompt, sessionId);
      if (pack) snippets.push(pack);
    } catch (e) {
      console.error(`[graft] prompt hook: ${(e as Error)?.message ?? e}`);
    }
    return snippets.length ? ompSetupMessage(snippets.join("\n\n")) : undefined;
  });

  pi.on("tool_result", async (event: ToolResultEventLike, ctx: ExtensionContextLike) => {
    if (ctx.agent.kind !== "main") return undefined;
    // MCP graft tool: count savings from the result and stop. Same shape as
    // hooks.ts's `handleCursorMcp` guard, so CLI and MCP tallies never double up.
    if (isGraftMcpTool(event.toolName)) {
      try {
        const savedTokens = parseSavings(JSON.stringify(event.content ?? ""));
        recordToolUse(ctx.cwd, ompSessionKey(ctx), { kind: "graft", savedTokens, host: "omp" });
      } catch (e) {
        console.error(`[graft] tool-savings: ${(e as Error)?.message ?? e}`);
      }
      return undefined;
    }
    if (isMcpToolName(event.toolName)) return undefined;
    // Edit/Write landed — the same work hooks.ts's `post-edit` branch runs.
    const file = ompEditedFilePath(event.input, ctx.cwd);
    if (file) {
      try {
        if (!underGraftDir(ctx.cwd, file)) {
          patchStats(ctx.cwd, { dirty: true, staleCount: ompCheckStaleCount(ctx.cwd), lastFile: basename(file) });
          const br = ompPostEditRadius(ctx.cwd, file);
          if (br) return { additionalContext: br };
          return undefined;
        }
      } catch (e) {
        console.error(`[graft] post-edit hook: ${(e as Error)?.message ?? e}`);
        return undefined;
      }
    }
    // Retrieval (Read/Grep/Glob/skeleton) — score the usage mix the same way
    // hooks.ts's `tool-savings` branch classifies. Bash with a graft command in
    // it counts as a graft read (a footer is itself proof).
    try {
      const command = typeof event.input.command === "string" ? event.input.command : undefined;
      const payload = () => event.content;
      const savedTokens = parseSavings(JSON.stringify(payload() ?? ""));
      recordToolUse(
        ctx.cwd,
        ompSessionKey(ctx),
        { kind: command && /graft\s/.test(command) ? "graft" : isMcpToolName(event.toolName) ? null : "source", savedTokens, host: "omp" },
      );
    } catch {
      void 0; // a metrics miss is a quieter event, never a crash
    }
    return undefined;
  });

  pi.on("agent_end", async (_event: AgentEndEventLike, ctx: ExtensionContextLike) => {
    if (ctx.agent.kind !== "main") return;
    try {
      const syncRun = claudeScript("sync-run.js");
      if (!existsSync(syncRun)) return;
      const stats = readStats(ctx.cwd);
      if (stats?.dirty && acquireLock(ctx.cwd)) {
        patchStats(ctx.cwd, { syncing: true });
        const child = spawn(process.execPath, [syncRun, ctx.cwd], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      }
    } catch {
      void 0; // a background sync failure is a missed refresh, never a crash
    }
  });
}
