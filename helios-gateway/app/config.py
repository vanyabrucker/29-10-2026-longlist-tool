from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent

# Base URL, model and auth style per known provider. Auth is "bearer" (Authorization)
# or "api-key" (api-key header). Any other OpenAI-compatible endpoint is configured
# with LLM_BASE_URL / LLM_MODEL (imports) or AGENT_LLM_BASE_URL / AGENT_LLM_MODEL.
PROVIDER_DEFAULTS = {
    "deepseek": ("https://api.deepseek.com", "deepseek-chat", "bearer"),
    "azure_foundry": (None, None, "api-key"),  # URL and model come from AZURE_*
    # No default model: name one (e.g. qwen/qwen3.8-27b) with the provider's model
    # field; the key is OPENROUTER_API_KEY.
    "openrouter": ("https://openrouter.ai/api/v1", None, "bearer"),
}

# USD per 1M tokens (input, output) for the cost on usage events: DeepSeek's
# list price. Other models (an Azure deployment) set TOKEN_PRICES in .env,
# e.g. {"DeepSeek-V4.1-Flash-1017": [0.3, 0.45]}; without a price the cost is
# left empty rather than guessed.
TOKEN_PRICES_PER_M: dict[str, tuple[float, float]] = {
    "deepseek-chat": (0.28, 0.42),
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    database_url: str = "postgresql+psycopg://helios:helios@localhost:5433/helios"

    s3_endpoint_url: str = "http://localhost:9010"
    s3_access_key: str = "helios"
    s3_secret_key: str = "helios"
    s3_bucket: str = "helios-sources"

    # Import / mapping LLM (JSON complete). Defaults to DeepSeek.
    llm_provider: str = "deepseek"
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    deepseek_api_key: str | None = None
    openrouter_api_key: str | None = None
    llm_timeout_seconds: float = 120

    # Agent chat LLM. Defaults to Azure AI Foundry (OpenAI-compatible).
    agent_llm_provider: str = "azure_foundry"
    agent_llm_base_url: str | None = None
    agent_llm_model: str | None = None
    agent_llm_api_key: str | None = None
    azure_foundry_endpoint: str | None = None
    azure_foundry_key: str | None = None
    azure_foundry_deployment_name: str | None = None
    agent_llm_timeout_seconds: float = 180

    # Embeddings for semantic company search. Default: a text-embedding-3-large
    # deployment on the same Azure AI Foundry resource (AZURE_FOUNDRY_ENDPOINT
    # and AZURE_FOUNDRY_EMBEDDING_KEY). Any OpenAI-compatible /embeddings endpoint works
    # with EMBEDDING_PROVIDER=openai-compatible plus EMBEDDING_BASE_URL,
    # EMBEDDING_MODEL and EMBEDDING_API_KEY. Vectors are stored at
    # EMBEDDING_DIMENSIONS, fixed by the migration (changing it needs one).
    embedding_provider: str = "azure_foundry"
    embedding_base_url: str | None = None
    embedding_model: str | None = None
    embedding_api_key: str | None = None
    azure_foundry_embedding_deployment_name: str | None = None
    azure_foundry_embedding_key: str | None = None
    embedding_dimensions: int = 1536
    embedding_timeout_seconds: float = 60
    # Embed changed companies in a background thread after each commit; tests
    # turn it off and embed synchronously.
    embed_in_background: bool = True

    # Web research (Exa). Off for the agent until the user approves a second pass.
    exa_api_key: str | None = None
    exa_base_url: str = "https://api.exa.ai"

    # {"model": [input, output]} in USD per 1M tokens; see TOKEN_PRICES_PER_M.
    token_prices: dict[str, tuple[float, float]] = {}

    # Signs the export id in every exported workbook (HMAC-SHA256), so an
    # import can trust which export a file came from. Any long random string.
    export_secret: str | None = None

    # Sent by the frontend as X-Gateway-Secret; unset disables the check.
    gateway_secret: str | None = None

    def _resolve(
        self, provider: str, base: str | None, model: str | None, key: str | None,
    ) -> tuple[str, str, str | None, str]:
        """(base_url, model, api_key, auth_style)."""
        default_base, default_model, auth = PROVIDER_DEFAULTS.get(
            provider, (None, None, "bearer"))
        if provider == "azure_foundry":
            default_base = self.azure_foundry_endpoint
            default_model = self.azure_foundry_deployment_name
            key = key or self.azure_foundry_key
            auth = "api-key"
        elif provider == "deepseek":
            key = key or self.deepseek_api_key
        elif provider == "openrouter":
            key = key or self.openrouter_api_key
        base_url = base or default_base
        model_name = model or default_model
        if not base_url or not model_name:
            raise RuntimeError(
                f"LLM provider '{provider}' needs a base URL and model "
                "(set LLM_* / AGENT_LLM_* or the provider's own vars)."
            )
        return base_url.rstrip("/"), model_name, key, auth

    @property
    def llm(self) -> tuple[str, str, str | None, str]:
        """Import LLM: (base_url, model, api_key, auth_style)."""
        return self._resolve(
            self.llm_provider, self.llm_base_url, self.llm_model, self.llm_api_key)

    @property
    def agent_llm(self) -> tuple[str, str, str | None, str]:
        """Agent chat LLM: (base_url, model, api_key, auth_style)."""
        return self._resolve(
            self.agent_llm_provider, self.agent_llm_base_url, self.agent_llm_model,
            self.agent_llm_api_key or self.llm_api_key)

    @property
    def embedding(self) -> tuple[str, str, str | None, str]:
        """Embeddings: (base_url, model, api_key, auth_style)."""
        if self.embedding_provider == "azure_foundry":
            base, model, _, auth = self._resolve(
                "azure_foundry", self.embedding_base_url,
                self.embedding_model or self.azure_foundry_embedding_deployment_name,
                None)
            return (base, model,
                    self.embedding_api_key or self.azure_foundry_embedding_key, auth)
        return self._resolve(self.embedding_provider, self.embedding_base_url,
                             self.embedding_model, self.embedding_api_key)

    def problems(self) -> list[str]:
        """What's missing or invalid for the server to run, one line each."""
        found = []
        for name in ("database_url", "s3_endpoint_url", "s3_access_key",
                     "s3_secret_key", "s3_bucket"):
            if not getattr(self, name).strip():
                found.append(f"{name.upper()} is set but empty.")

        # Import LLM
        if self.llm_provider not in PROVIDER_DEFAULTS and not (
            self.llm_base_url and self.llm_model
        ):
            found.append(
                f"LLM_PROVIDER '{self.llm_provider}' isn't built in, so it needs "
                "LLM_BASE_URL and LLM_MODEL."
            )
        if self.llm_provider == "deepseek" and not (
            self.llm_api_key or self.deepseek_api_key
        ):
            found.append("DEEPSEEK_API_KEY (or LLM_API_KEY) is missing.")
        if self.llm_provider == "openrouter":
            if not (self.llm_api_key or self.openrouter_api_key):
                found.append("OPENROUTER_API_KEY (or LLM_API_KEY) is missing.")
            if not self.llm_model:
                found.append("LLM_MODEL is missing for OPENROUTER (e.g. qwen/qwen3.8-27b).")

        # Agent LLM
        if self.agent_llm_provider not in PROVIDER_DEFAULTS and not (
            self.agent_llm_base_url and self.agent_llm_model
        ):
            found.append(
                f"AGENT_LLM_PROVIDER '{self.agent_llm_provider}' isn't built in, "
                "so it needs AGENT_LLM_BASE_URL and AGENT_LLM_MODEL."
            )
        if self.agent_llm_provider == "azure_foundry":
            if not (self.azure_foundry_endpoint or self.agent_llm_base_url):
                found.append("AZURE_FOUNDRY_ENDPOINT (or AGENT_LLM_BASE_URL) is missing.")
            if not (self.azure_foundry_key or self.agent_llm_api_key or self.llm_api_key):
                found.append("AZURE_FOUNDRY_KEY (or AGENT_LLM_API_KEY) is missing.")
            if not (self.azure_foundry_deployment_name or self.agent_llm_model):
                found.append(
                    "AZURE_FOUNDRY_DEPLOYMENT_NAME (or AGENT_LLM_MODEL) is missing.")
        elif self.agent_llm_provider == "deepseek" and not (
            self.agent_llm_api_key or self.llm_api_key or self.deepseek_api_key
        ):
            found.append(
                "DEEPSEEK_API_KEY (or AGENT_LLM_API_KEY) is missing for the agent.")
        elif self.agent_llm_provider == "openrouter":
            if not (self.agent_llm_api_key or self.llm_api_key or self.openrouter_api_key):
                found.append(
                    "OPENROUTER_API_KEY (or AGENT_LLM_API_KEY) is missing for the agent.")
            if not self.agent_llm_model:
                found.append("AGENT_LLM_MODEL is missing for OPENROUTER "
                             "(e.g. qwen/qwen3.8-27b).")

        # Embeddings (semantic search)
        if self.embedding_provider == "azure_foundry":
            if not (self.azure_foundry_endpoint or self.embedding_base_url):
                found.append("AZURE_FOUNDRY_ENDPOINT (or EMBEDDING_BASE_URL) is "
                             "missing for embeddings.")
            if not (self.azure_foundry_embedding_key or self.embedding_api_key):
                found.append("AZURE_FOUNDRY_EMBEDDING_KEY (or EMBEDDING_API_KEY) is "
                             "missing for embeddings.")
            if not (self.azure_foundry_embedding_deployment_name or self.embedding_model):
                found.append(
                    "AZURE_FOUNDRY_EMBEDDING_DEPLOYMENT_NAME (or EMBEDDING_MODEL) is "
                    "missing: the name of a text-embedding-3-large deployment.")
        elif not (self.embedding_base_url and self.embedding_model):
            found.append(
                f"EMBEDDING_PROVIDER '{self.embedding_provider}' needs "
                "EMBEDDING_BASE_URL and EMBEDDING_MODEL.")
        if self.embedding_dimensions != 1536:
            found.append("EMBEDDING_DIMENSIONS must be 1536 (the column size the "
                         "migration created).")

        if not self.exa_api_key:
            found.append("EXA_API_KEY is missing.")
        if not self.export_secret:
            found.append("EXPORT_SECRET is missing (signs exported workbooks; "
                         "any random string of 32+ characters).")
        elif len(self.export_secret) < 32:
            found.append("EXPORT_SECRET is too short; use 32 characters or more.")
        return found


class ConfigError(RuntimeError):
    pass


@lru_cache
def settings() -> Settings:
    return Settings()


def check() -> None:
    """Fails startup with every missing or invalid setting listed at once."""
    found = settings().problems()
    if found:
        lines = "\n".join(f"  - {p}" for p in found)
        raise ConfigError(
            f"Helios gateway can't start; fix its configuration:\n{lines}\n"
            f"Set them in the environment or in {ROOT / '.env'} "
            "(see .env.example)."
        )


def estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float | None:
    prices = settings().token_prices.get(model) or TOKEN_PRICES_PER_M.get(model)
    if not prices:
        return None
    inn, out = prices
    return round((prompt_tokens * inn + completion_tokens * out) / 1_000_000, 6)
