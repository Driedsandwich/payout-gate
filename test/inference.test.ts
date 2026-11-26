import { DeveloperMessageItem, ModelContext, UserMessageItem } from "@mozaik-ai/core";
import { afterEach, expect, it, vi } from "vitest";
import { liveRunner } from "../src/core/inference.js";
import { Ledger } from "../src/core/ledger.js";

const fixtures = [
  {
    provider: "openrouter", key: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    response: {
      choices: [{ message: { content: "Mock answer." } }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
  },
  {
    provider: "anthropic", key: "ANTHROPIC_API_KEY",
    url: "https://api.anthropic.com/v1/messages",
    response: {
      content: [{ type: "text", text: "Mock answer." }],
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  },
  {
    provider: "openai", key: "OPENAI_API_KEY",
    url: "https://api.openai.com/v1/responses",
    response: {
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Mock answer." }] }],
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    },
  },
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(fixtures)("uses the Mozaik $provider endpoint with the selected model and key", async (fixture) => {
  vi.stubEnv("OPENAI_API_KEY", "mock-openai-fallback");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "mock-unwanted-bearer");
  const key = "mock-selected-provider-key";
  vi.stubEnv(fixture.key, key);
  const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => Response.json(fixture.response));
  vi.stubGlobal("fetch", fetchMock);

  const model = `mock-${fixture.provider}-custom-model`;
  const runner = liveRunner({ kind: "live", provider: fixture.provider, model }, new Ledger([], () => 0, () => {}));
  const context = ModelContext.create().addContextItems([
    DeveloperMessageItem.create("Answer the task."),
    UserMessageItem.create("Test"),
  ]);
  const output = await runner.run({ model, context, maxOutputTokens: 20 });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(fixture.url);
  expect(JSON.parse(String(init.body))).toHaveProperty("model", model);
  const headers = new Headers(init.headers);
  if (fixture.provider === "anthropic") {
    expect(headers.get("x-api-key")).toBe(key);
    expect(headers.has("authorization")).toBe(false);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe("mock-unwanted-bearer");
  } else {
    expect(headers.get("authorization")).toBe(`Bearer ${key}`);
  }
  expect(output.items[0]).toMatchObject({ content: { text: "Mock answer." } });
  expect(output.tokenUsage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
});
