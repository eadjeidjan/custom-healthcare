"""Settings from environment variables (and api/.env when running locally)."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

VERSION = "1.0.0"
DISCLAIMER = ("Decision support only, not a diagnosis. The risk model is trained on synthetic data and must be "
              "validated before clinical use. Red flags always mean: seek emergency care.")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "development"
    database_url: str = "postgresql+psycopg://sg:sg@localhost:5470/sickleguard"
    qdrant_url: str = "http://localhost:6350"
    qdrant_api_key: str = ""
    collection: str = "sickle_guidance"

    openai_api_key: str = ""
    chat_model: str = "gpt-4.1-mini"
    embed_model: str = "text-embedding-3-small"
    embed_dims: int = 1536

    mcp_url: str = "http://localhost:8211/mcp"
    mcp_token: str = ""
    mcp_port: int = 8211

    jwt_secret: str = "dev-only-change-me"
    jwt_hours: int = 12
    admin_email: str = "admin@sickleguard.local"
    admin_password: str = ""
    cors_origins: str = "http://localhost:5310"
    seed_demo: bool = True
    # password for the demo accounts of each role (clinician@, patient@, policy@sickleguard.local); empty = none
    demo_password: str = ""
    # uploaded files (imaging) live here; a Docker volume in production
    data_dir: str = "data"
    # sample IoT feed for simulated devices; unset = on in development with Postgres, off in production and tests
    simulate_devices: bool | None = None

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def uses_postgres(self) -> bool:
        return self.database_url.startswith("postgresql")

    @property
    def psycopg_url(self) -> str:
        return self.database_url.replace("postgresql+psycopg://", "postgresql://")


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.is_production:
        if s.jwt_secret.startswith("dev-") or len(s.jwt_secret) < 32:
            raise RuntimeError("Set JWT_SECRET to a long random value in production.")
        if not s.mcp_token:
            raise RuntimeError("Set MCP_TOKEN in production.")
    return s
