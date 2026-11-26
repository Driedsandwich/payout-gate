import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { SemanticEvent } from "@mozaik-ai/core";
import type { RunEvent } from "./types.js";

export type EventDraft = Omit<RunEvent, "runId" | "seq" | "tMs">;
type ObservedEvent = Omit<EventDraft, "kind"> & { kind: string };

const credentialName = String.raw`(?:authorization|(?:[\w-]+[_-])?(?:api[_-]?key|project[_-]?key|private[_-]?key|secret[_-]?access[_-]?key|(?:access|refresh|auth)[_-]?token|token|password|secret))`;
const credentialField = new RegExp(`^${credentialName}$`, "i");
const credentialValue = /\b(?:sk-[\w-]{8,}|[sr]k_(?:live|test)_[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|xox[baprs]-[\w-]{8,}|AIza[\w-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+)\b/g;
const homePath = /(?:\/(?:home|Users)\/[^/\s"'<>\\]+|\/root\b|[A-Z]:[\\/]+Users[\\/]+[^/\s"'<>\\]+)(?:[\\/][^\s"'<>]*)?/gi;
const assignedValue = new RegExp(String.raw`(?<![\w-])(["']?)(${credentialName})\1(\s*[:=]\s*)("[^"]*"|'[^']*'|(?:Bearer\s+|Basic\s+)?[^\s,;}]+)`, "gi");
const omittedPayloadFields = new Set(["rowResponse", "encryptedContent"]);

export function makeScrubber(env: NodeJS.ProcessEnv = process.env) {
  const knownSecrets = [...new Set(Object.entries(env)
    .filter(([name, value]) => credentialField.test(name) && value && value.length >= 6)
    .map(([, value]) => value!))]
    .sort((a, b) => b.length - a.length);
  const localHome = homedir();

  return (text: string): string => {
    for (const secret of knownSecrets) text = text.replaceAll(secret, "[redacted]");
    return text
      .replace(credentialValue, "[redacted]")
      .replace(assignedValue, (_match, quotes: string, name: string, separator: string, value: string) => {
        const quote = /^["']/.test(value) ? value[0] : "";
        return `${quotes}${name}${quotes}${separator}${quote}[redacted]${quote}`;
      })
      .replace(/\b(Bearer|Basic)\s+[\w.+/=-]{6,}/gi, "$1 [redacted]")
      .replace(homePath, "[home-path]")
      .replaceAll(localHome === "/" ? "\0" : localHome, "[home-path]");
  };
}

function jsonSafe(
  value: unknown,
  scrub: (text: string) => string,
  trim: boolean,
  depth = 0,
  ancestors = new Set<object>(),
): unknown {
  if (typeof value === "string") {
    const safe = scrub(value);
    return trim && safe.length > 8_000 ? `${safe.slice(0, 8_000)}…` : safe;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object" || value === null) {
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (value instanceof Date) return value.toJSON();
  if (ancestors.has(value) || (trim && depth > 10)) return "[omitted]";
  ancestors.add(value);
  const safe = Array.isArray(value)
    ? (trim ? value.slice(0, 100) : value).map((entry) => jsonSafe(entry, scrub, trim, depth + 1, ancestors))
    : Object.fromEntries(Object.keys(value).flatMap((key) => {
      if (trim && omittedPayloadFields.has(key)) return [];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return [];
      return [[scrub(key), credentialField.test(key)
        ? "[redacted]"
        : jsonSafe(descriptor.value, scrub, trim, depth + 1, ancestors)]];
    }));
  ancestors.delete(value);
  return safe;
}

export class EventLog {
  readonly path: string;
  private fd?: number;
  private start = performance.now();
  private readonly scrub = makeScrubber();
  private seq = 0;
  private lastMs = 0;

  constructor(private readonly runId: string, directory: string) {
    this.path = join(directory, "events.jsonl");
  }

  nowMs = () => performance.now() - this.start;

  emit = (draft: EventDraft): void => {
    this.append(draft);
  };

  observe(event: SemanticEvent, agent: string | undefined): void {
    const payload = event.payload as {
      loopId?: string;
      tokenUsage?: { inputTokens?: number; outputTokens?: number };
    } | undefined;
    const usage = payload?.tokenUsage;
    const data: Record<string, unknown> = { payload: jsonSafe(event.payload, this.scrub, true) };
    if (event.type === "inference.completed" &&
        typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number") {
      data.usage = { input: usage.inputTokens, output: usage.outputTokens };
    }
    this.append({ kind: event.type, agent, loopId: payload?.loopId, data });
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
  }

  private append(draft: ObservedEvent): void {
    if (this.fd === undefined) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.fd = openSync(this.path, "wx");
      this.start = performance.now();
    }
    const tMs = this.seq ? Math.max(this.nowMs(), this.lastMs + 0.000_001) : 0;
    const event = { runId: this.runId, seq: ++this.seq, tMs, ...draft };
    appendFileSync(this.fd, JSON.stringify(jsonSafe(event, this.scrub, false)) + "\n");
    this.lastMs = tMs;
  }
}
