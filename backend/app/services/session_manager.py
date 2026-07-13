from __future__ import annotations

import json
from pathlib import Path

from app.config import settings
from app.logger import browser_logger


class SessionManager:
    """Manages Playwright browser storage-state JSON files."""

    def __init__(self, session_dir: str | None = None) -> None:
        self.session_dir = Path(session_dir or settings.session_dir)
        self.session_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, account_name: str) -> Path:
        safe_name = account_name.replace("/", "_").replace("\\", "_")
        return self.session_dir / f"{safe_name}.json"

    def save_session(self, account_name: str, storage_state: dict) -> Path:
        path = self._path(account_name)
        path.write_text(json.dumps(storage_state, indent=2), encoding="utf-8")
        browser_logger.info("Session saved | account=%s path=%s", account_name, path)
        return path

    def load_session(self, account_name: str) -> dict | None:
        path = self._path(account_name)
        if not path.exists():
            browser_logger.warning("Session file not found | account=%s", account_name)
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            browser_logger.debug("Session loaded | account=%s", account_name)
            return data
        except json.JSONDecodeError as exc:
            browser_logger.error("Session file corrupt | account=%s error=%s", account_name, exc)
            return None

    def validate_session(self, account_name: str) -> bool:
        data = self.load_session(account_name)
        if data is None:
            return False
        cookies = data.get("cookies", [])
        # A session is considered valid if it has at least one cookie
        return len(cookies) > 0

    def delete_session(self, account_name: str) -> bool:
        path = self._path(account_name)
        if path.exists():
            path.unlink()
            browser_logger.info("Session deleted | account=%s", account_name)
            return True
        return False

    def list_sessions(self) -> list[str]:
        return [p.stem for p in self.session_dir.glob("*.json")]
