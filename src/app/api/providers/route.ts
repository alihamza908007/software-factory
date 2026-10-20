import { apiError, json } from "@/lib/api";
import { getSettings } from "@/lib/db";
import { probeProvider } from "@/lib/llm/universal-provider";
import { listModels } from "@/lib/providers/catalog";
import type { ModelProvider, ProviderHealth } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LABELS: Record<ModelProvider, { label: string; local: boolean; url?: string; configured?: boolean }> = {
  ollama: { label: "Ollama", local: true },
  lmstudio: { label: "LM Studio", local: true },
  opencode: { label: "OpenCode cloud", local: false },
  openrouter: { label: "OpenRouter", local: false, url: "https://openrouter.ai" },
  anthropic: { label: "Anthropic", local: false, url: "https://api.anthropic.com" },
  openai: { label: "OpenAI", local: false, url: "https://api.openai.com" },
  google: { label: "Google Gemini", local: false, url: "https://ai.google.dev" },
};

export async function GET() {
  try {
    const settings = await getSettings();
    const catalogue = await listModels();
    const providers: ProviderHealth[] = await Promise.all(
      (Object.keys(LABELS) as ModelProvider[]).map(async (provider) => {
        const meta = LABELS[provider];
        const probe = await probeProvider(provider, settings);
        return {
          provider,
          label: meta.label,
          online: provider === "opencode" ? catalogue.opencodeOnline : probe.online,
          configured:
            provider === "openrouter"
              ? Boolean(settings.openrouterApiKey)
              : provider === "anthropic"
                ? Boolean(settings.anthropicApiKey)
                : provider === "openai"
                  ? Boolean(settings.openaiApiKey)
                  : provider === "google"
                    ? Boolean(settings.geminiApiKey)
                    : true,
          local: meta.local,
          detail:
            provider === "opencode"
              ? catalogue.opencodeOnline
                ? "free-tier CLI available"
                : "offline"
              : probe.detail,
          url:
            provider === "ollama"
              ? settings.ollamaUrl
              : provider === "lmstudio"
                ? settings.lmstudioUrl
                : meta.url,
        };
      }),
    );
    return json({
      providers,
      modelCounts: {
        ollama: catalogue.models.filter((model) => model.provider === "ollama").length,
        lmstudio: catalogue.models.filter((model) => model.provider === "lmstudio").length,
        opencode: catalogue.models.filter((model) => model.provider === "opencode").length,
        openrouter: catalogue.models.filter((model) => model.provider === "openrouter").length,
        anthropic: catalogue.models.filter((model) => model.provider === "anthropic").length,
        openai: catalogue.models.filter((model) => model.provider === "openai").length,
        google: catalogue.models.filter((model) => model.provider === "google").length,
      },
      envFile: ".env.local",
    });
  } catch (error) {
    return apiError(error);
  }
}
