// Marketr — LLM provider factory.
// Today: OpenAI-compatible endpoint when a key exists, mock otherwise.
// To add a provider: implement LlmProvider, add a branch here.

import { OpenAiCompatibleLlmProvider } from "./openai";
import { MockLlmProvider } from "./mock";
import type { LlmProvider } from "./types";

export function getLlmProvider(): LlmProvider {
  const apiKey = (
    process.env.LLM_API_KEY ??
    process.env.OPENAI_API_KEY ??
    ""
  ).trim();
  const model = (process.env.LLM_MODEL ?? "gpt-4o-mini").trim();
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").trim();
  if (apiKey) {
    return new OpenAiCompatibleLlmProvider(apiKey, model, baseUrl);
  }
  return new MockLlmProvider();
}

export function llmStatus() {
  const provider = getLlmProvider();
  const model =
    provider instanceof OpenAiCompatibleLlmProvider
      ? provider.getModel()
      : null;
  return {
    name: provider.name,
    isLive: provider.isLive,
    configured: provider.isConfigured(),
    model,
  };
}
