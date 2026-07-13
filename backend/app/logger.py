from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from app.config import settings

_LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s"
_DATE_FORMAT = "%Y-%m-%dT%H:%M:%S"

_LOG_FILES = {
    "app": "app.log",
    "celery": "celery.log",
    "browser": "browser.log",
    "scheduler": "scheduler.log",
}

_loggers: dict[str, logging.Logger] = {}


def _build_logger(name: str, filename: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(settings.log_level.upper())
    formatter = logging.Formatter(_LOG_FORMAT, datefmt=_DATE_FORMAT)

    # ── rotating file handler ─────────────────────────────────────────────────
    log_path = Path(settings.log_dir) / filename
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fh = RotatingFileHandler(
        log_path,
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    fh.setFormatter(formatter)

    # ── stdout handler ────────────────────────────────────────────────────────
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(formatter)

    logger.addHandler(fh)
    logger.addHandler(sh)
    logger.propagate = False
    return logger


def get_logger(name: str) -> logging.Logger:
    if name not in _loggers:
        filename = _LOG_FILES.get(name, f"{name}.log")
        _loggers[name] = _build_logger(name, filename)
    return _loggers[name]


# Module-level convenience loggers
app_logger = get_logger("app")
celery_logger = get_logger("celery")
browser_logger = get_logger("browser")
scheduler_logger = get_logger("scheduler")
