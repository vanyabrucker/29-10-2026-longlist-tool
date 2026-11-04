from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent

# Base URL and model per known provider; any other OpenAI-compatible endpoint
# is configured with LLM_BASE_URL and LLM_MODEL directly.
PROVIDER_DEFAULTS = {
    "deepseek": ("https://api.deepseek.com", "deepseek-chat"),
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    database_url: str = "postgresql+psycopg://helios:helios@localhost:5433/helios"

    s3_endpoint_url: str = "http://localhost:9010"
    s3_access_key: str = "helios"
    s3_secret_key: str = "helios"
    s3_bucket: str = "helios-sources"

    llm_provider: str = "deepseek"
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_api_key: str | None = None
    deepseek_api_key: str | None = None
    llm_timeout_seconds: float = 120

    # Sent by the frontend as X-Gateway-Secret; unset disables the check.
    gateway_secret: str | None = None

    @property
    def llm(self) -> tuple[str, str, str | None]:
        """(base_url, model, api_key) for the configured provider."""
        base, model = PROVIDER_DEFAULTS.get(self.llm_provider, (None, None))
        key = self.llm_api_key or (
            self.deepseek_api_key if self.llm_provider == "deepseek" else None
        )
        base_url = self.llm_base_url or base
        model_name = self.llm_model or model
        if not base_url or not model_name:
            raise RuntimeError(
                f"LLM provider '{self.llm_provider}' needs LLM_BASE_URL and LLM_MODEL"
            )
        return base_url, model_name, key


@lru_cache
def settings() -> Settings:
    return Settings()
