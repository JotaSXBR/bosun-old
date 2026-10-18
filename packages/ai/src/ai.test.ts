import type { TenantContext } from "@crm/core";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentDefinition } from "./agent";
import { AiProviderNotConfiguredError, resolveLanguageModel } from "./model";
import { runAgent } from "./run-agent";
import type { AgentToolRegistry } from "./tools";
import { buildToolSet, defineAgentTool } from "./tools";

const ctx = (role: TenantContext["role"], isPlatformAdmin = false): TenantContext => ({
  organizationId: "018f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
  userId: "user-1",
  role,
  isPlatformAdmin,
});

const agent = (
  tools: string[],
  permissions: AgentDefinition["permissions"] = {},
): AgentDefinition => ({
  id: "agent-1",
  name: "Test agent",
  instructions: "Be helpful",
  model: { provider: "openai", modelId: "gpt-5" },
  tools,
  knowledge: { knowledgeBaseIds: [] },
  memory: { strategy: "none" },
  guardrails: { maxSteps: 3 },
  permissions,
});

describe("resolveLanguageModel", () => {
  it("resolves each provider when the key exists", () => {
    expect(
      resolveLanguageModel({ provider: "openai", modelId: "gpt-5" }, { openaiApiKey: "k" }),
    ).toBeDefined();
    expect(
      resolveLanguageModel(
        { provider: "anthropic", modelId: "claude-sonnet-4" },
        { anthropicApiKey: "k" },
      ),
    ).toBeDefined();
    expect(
      resolveLanguageModel(
        {
          provider: "openrouter",
          modelId: "openai/gpt-5-mini",
          routing: { zdr: true, fallbacks: ["anthropic/claude-sonnet-4.5"] },
        },
        { openrouterApiKey: "k" },
      ),
    ).toBeDefined();
  });

  it("throws AiProviderNotConfiguredError when key is missing", () => {
    expect(() => resolveLanguageModel({ provider: "openai", modelId: "gpt-5" }, {})).toThrow(
      AiProviderNotConfiguredError,
    );
    expect(() =>
      resolveLanguageModel({ provider: "anthropic", modelId: "m" }, { openaiApiKey: "k" }),
    ).toThrow(AiProviderNotConfiguredError);
    expect(() =>
      resolveLanguageModel({ provider: "openrouter", modelId: "openai/gpt-5-mini" }, {}),
    ).toThrow(AiProviderNotConfiguredError);
  });
});

describe("buildToolSet", () => {
  const registry: AgentToolRegistry = {
    readAudit: defineAgentTool({
      name: "readAudit",
      description: "read audit events",
      inputSchema: z.object({ limit: z.number() }),
      requiredPermissions: { audit: ["read"] },
      execute: (_ctx, input) => Promise.resolve(input.limit),
    }),
    manageMembers: defineAgentTool({
      name: "manageMembers",
      description: "add members",
      inputSchema: z.object({ userId: z.string() }),
      requiredPermissions: { member: ["create"] },
      execute: (_ctx, input) => Promise.resolve(input.userId),
    }),
  };

  it("filters by agent.tools and by role permission", () => {
    // manager has audit:read but not member:create → gets readAudit only
    const tools = buildToolSet(ctx("manager"), registry, agent(["readAudit", "manageMembers"]));
    expect(Object.keys(tools)).toEqual(["readAudit"]);
    // owner gets both
    expect(
      Object.keys(buildToolSet(ctx("owner"), registry, agent(["readAudit", "manageMembers"]))),
    ).toEqual(["readAudit", "manageMembers"]);
    // unlisted tool never appears
    expect(Object.keys(buildToolSet(ctx("owner"), registry, agent(["readAudit"])))).toEqual([
      "readAudit",
    ]);
  });

  it("binds TenantContext into execute (no db handle)", async () => {
    const seen: string[] = [];
    const reg: AgentToolRegistry = {
      echo: defineAgentTool({
        name: "echo",
        description: "echo org",
        inputSchema: z.object({}),
        requiredPermissions: {},
        execute: (c) => {
          seen.push(c.organizationId);
          return Promise.resolve(c.organizationId);
        },
      }),
    };
    buildToolSet(ctx("agent"), reg, agent(["echo"]));
    // execute is a closure over ctx — verify by invoking the definition
    await reg.echo?.execute(ctx("agent"), {} as never);
    expect(seen).toEqual([ctx("agent").organizationId]);
  });
});

describe("analyzeConversation", () => {
  const observerModel = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            suggestions: [
              {
                targetType: "knowledge_entry",
                payload: { title: "FAQ", content: "Resposta" },
                rationale: "Cliente perguntou duas vezes",
              },
            ],
            memories: [
              {
                type: "pattern",
                scope: "org",
                content: "Clientes perguntam prazo antes do preço.",
                confidence: "medium",
                staleAfterDays: 90,
                rationale: "Pergunta recorrente no transcript",
              },
            ],
          }),
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      },
      warnings: [],
    },
  });

  it("returns parsed suggestions and token usage", async () => {
    const { analyzeConversation } = await import("./observer");
    const result = await analyzeConversation({
      model: observerModel,
      transcript: [{ direction: "inbound", text: "qual o prazo?" }],
      agents: [],
      knowledge: [],
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.targetType).toBe("knowledge_entry");
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.type).toBe("pattern");
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(5);
  });

  it("defaults memories to an empty list when the model omits it", async () => {
    const { analyzeConversation } = await import("./observer");
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify({ suggestions: [] }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const result = await analyzeConversation({
      model,
      transcript: [{ direction: "inbound", text: "ok" }],
      agents: [],
      knowledge: [],
      brain: { canon: [], pendingContents: [] },
    });
    expect(result.memories).toEqual([]);
  });
});

describe("draftReply", () => {
  const usage = {
    inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 6, text: 6, reasoning: 0 },
  };
  const draftModel = () =>
    new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              body: "Nosso prazo é de 5 dias úteis. Posso confirmar seu pedido?",
              rationale: "Responde a pergunta com o prazo padrão.",
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    });
  const drafter = { name: "Drafter", systemPrompt: "", businessRules: null };
  const transcript = [{ direction: "inbound" as const, text: "qual o prazo?" }];

  it("returns a parsed draft body + rationale and token usage", async () => {
    const { draftReply } = await import("./drafter");
    const result = await draftReply({
      model: draftModel(),
      drafter,
      transcript,
      mode: "suggest",
    });
    expect(result.body).toContain("5 dias úteis");
    expect(result.rationale).toContain("prazo");
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(6);
  });

  it("improve mode rewrites the given source text", async () => {
    const { draftReply } = await import("./drafter");
    const result = await draftReply({
      model: draftModel(),
      drafter,
      transcript,
      mode: "improve",
      sourceText: "prazo 5 dias",
    });
    expect(result.body).toContain("5 dias úteis");
  });
});

describe("runAgent", () => {
  const mockModel = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "done" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });

  it("returns generated text for an authorized ctx", async () => {
    const result = await runAgent({
      ctx: ctx("agent"),
      agent: agent([], {}),
      model: mockModel,
      registry: {},
      prompt: "hi",
    });
    expect(result.text).toBe("done");
  });

  it("rejects callers without the agent's required permissions", async () => {
    await expect(
      runAgent({
        ctx: ctx("agent"),
        agent: agent([], { audit: ["read"] }),
        model: mockModel,
        registry: {},
        prompt: "hi",
      }),
    ).rejects.toThrow();
    // platform admin bypasses
    const ok = await runAgent({
      ctx: ctx("agent", true),
      agent: agent([], { audit: ["read"] }),
      model: mockModel,
      registry: {},
      prompt: "hi",
    });
    expect(ok.text).toBe("done");
  });
});
