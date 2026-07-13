from __future__ import annotations

import io
import csv
from typing import Any

from app.logger import app_logger
from app.models import Lead, LeadStatus


class LeadImporter:
    """Import leads from CSV bytes or a list of dicts."""

    REQUIRED_FIELDS = {"name"}
    OPTIONAL_FIELDS = {"company", "linkedin_url", "email", "status"}

    async def import_from_csv(self, data: bytes, db) -> dict[str, Any]:
        text = data.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        rows = [dict(row) for row in reader]
        return await self.import_from_list(rows, db)

    async def import_from_list(self, rows: list[dict[str, Any]], db) -> dict[str, Any]:
        created = 0
        skipped = 0
        errors: list[dict] = []

        for idx, row in enumerate(rows):
            try:
                name = (row.get("name") or "").strip()
                if not name:
                    skipped += 1
                    errors.append({"row": idx + 1, "error": "name is required"})
                    continue

                status_raw = (row.get("status") or "PENDING").strip().upper()
                try:
                    status = LeadStatus(status_raw)
                except ValueError:
                    status = LeadStatus.PENDING

                lead = Lead(
                    name=name,
                    company=(row.get("company") or "").strip() or None,
                    linkedin_url=(row.get("linkedin_url") or "").strip() or None,
                    email=(row.get("email") or "").strip() or None,
                    status=status,
                )
                db.add(lead)
                created += 1
            except Exception as exc:
                skipped += 1
                errors.append({"row": idx + 1, "error": str(exc)})

        await db.flush()
        app_logger.info("LeadImporter | created=%s skipped=%s", created, skipped)
        return {"created": created, "skipped": skipped, "errors": errors}
