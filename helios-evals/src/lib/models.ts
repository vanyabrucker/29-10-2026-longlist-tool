// Readable names for the eval's model specs (`provider[:model]`, as passed to
// `-T agent_model=` / `judge_model=`). Mirrors the gateway's PROVIDER_DEFAULTS
// (app/config.py): a spec without a model uses the provider's default.

const PROVIDERS: Record<string, { host: string; defaultModel?: string }> = {
  deepseek: { host: "DeepSeek API", defaultModel: "deepseek-chat" },
  azure_foundry: { host: "Azure AI Foundry" },
  openrouter: { host: "OpenRouter" },
  fake: { host: "scripted fake" },
};

// API aliases to the model they serve (DeepSeek's Models & Pricing page).
const VERSIONS: Record<string, string> = {
  "deepseek-flash": "DeepSeek-V4.1-Flash-1017",
  "deepseek-v4-flash": "DeepSeek-V4.1-Flash-1017",
};

/** "deepseek:deepseek-flash" → "DeepSeek-V4.1-Flash-1017 (DeepSeek API)". */
export function modelLabel(spec: string): string {
  if (!spec || spec === "none") return "none";
  const at = spec.indexOf(":");
  const [provider, model] = at < 0 ? [spec, ""] : [spec.slice(0, at), spec.slice(at + 1)];
  const p = PROVIDERS[provider];
  if (!p) return spec;
  if (provider === "fake") return "Scripted fake";
  const name = model || p.defaultModel || "deployment from .env";
  return `${VERSIONS[name] ?? name} (${p.host})`;
}

export const pairLabel = (agent: string, judge: string) =>
  `Agent ${modelLabel(agent)} · Judge ${modelLabel(judge)}`;
