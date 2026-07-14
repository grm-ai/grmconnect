from __future__ import annotations

import asyncio

from app.config import settings
from app.logger import app_logger

# Remembers the first Gemini model that actually generated in this process, so we don't re-probe
# unavailable models on every request (model availability differs per environment/region).
_WORKING_GEMINI_MODEL: str | None = None


class AIGenerator:
    """
    Generates personalised outreach messages.
    Primary: Google Gemini Flash (fast, cheap, good quality).
    Fallback: Anthropic Claude Haiku.
    Last resort: built-in template.
    """

    def __init__(self, sender: dict | None = None, keys: dict | None = None) -> None:
        self._gemini = None
        self._anthropic = None
        # Set whenever a real AI call fails / no key is configured, so callers can surface WHY
        # a fallback template was used (invalid key, quota, network, etc.) instead of failing silently.
        self.last_error: str | None = None

        # Sender profile ("About You") — passed in per-user by the caller. Background jobs with no
        # user context get an empty profile (no personalisation), never another user's data.
        self._sender = sender or {}

        # Resolve keys: the caller's OWN (per-user) key first, else the env var. We never read a
        # shared/global key file here — each account uses only its own key.
        def _resolve(attr: str) -> str:
            if keys and str(keys.get(attr) or "").strip():
                return str(keys[attr]).strip()
            return getattr(settings, attr, "") or ""

        gemini_key    = _resolve("gemini_api_key")
        anthropic_key = _resolve("anthropic_api_key")

        # ── Gemini (primary) ──────────────────────────────────────────────────
        # Model availability varies by environment/region (some models 404 "not available to new
        # users" on the server even though they work elsewhere), so we try an ordered list of
        # candidates at call time and use the first that works — instead of pinning one model.
        if gemini_key:
            try:
                import google.generativeai as genai
                genai.configure(api_key=gemini_key)
                self._genai = genai
                self._gemini = True  # marker: Gemini is available (actual model chosen in _call_gemini)
                env_model = (getattr(settings, "gemini_model", "") or "").strip()
                candidates = ([env_model] if env_model else []) + [
                    "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash-lite",
                    "gemini-flash-lite-latest", "gemini-2.5-flash-lite",
                ]
                seen: set[str] = set()
                self._gemini_models = [m for m in candidates if m and not (m in seen or seen.add(m))]
                app_logger.info("AIGenerator: Gemini ready (models=%s)", self._gemini_models)
            except ImportError:
                app_logger.warning(
                    "google-generativeai not installed — run: pip install google-generativeai"
                )
            except Exception as exc:
                app_logger.warning("AIGenerator: Gemini init failed: %s", exc)

        # ── Anthropic (fallback) ──────────────────────────────────────────────
        if anthropic_key:
            try:
                import anthropic
                self._anthropic = anthropic.Anthropic(api_key=anthropic_key)
                if not self._gemini:
                    app_logger.info("AIGenerator: Anthropic Claude ready (no Gemini key)")
            except ImportError:
                app_logger.warning("anthropic package not installed")
            except Exception as exc:
                app_logger.warning("AIGenerator: Anthropic init failed: %s", exc)

    # ── Public methods ─────────────────────────────────────────────────────────

    async def generate_connect_note(
        self,
        lead_name: str,
        lead_company: str | None = None,
        lead_title: str | None = None,
        context: str = "",
    ) -> str:
        if not self._gemini and not self._anthropic:
            return self._fallback_connect(lead_name, lead_company)

        lines = [
            f"Write a short LinkedIn connection request note (strictly under 280 characters) to {lead_name}",
        ]
        if lead_title:
            lines.append(f"who is a {lead_title}")
        if lead_company:
            lines.append(f"at {lead_company}")
        if context:
            lines.append(f"Context: {context}")
        sender = self._sender_context()
        if sender:
            lines.append(sender)
        lines.append(
            "Rules: be warm and specific, mention something concrete about their role or company, "
            "no hashtags, no emojis, no generic openers like 'I came across your profile'."
            + self._no_placeholder_rule()
            + " Output ONLY the note text, nothing else."
        )

        # If the AI call fails/returns empty (quota, network, etc.), fall back to a real
        # template note — NEVER return empty, or the invite would go out with a blank note.
        note = await self._call(". ".join(lines))
        return note or self._fallback_connect(lead_name, lead_company)

    async def generate_message(
        self,
        lead_name: str,
        lead_company: str | None = None,
        purpose: str = "",
    ) -> str:
        if not self._gemini and not self._anthropic:
            return self._fallback_message(lead_name)

        prompt = (
            f"Write a concise LinkedIn outreach message (2-3 sentences, under 500 characters) "
            f"to {lead_name}"
            + (f" at {lead_company}" if lead_company else "")
            + (f" about: {purpose}" if purpose else "")
            + ". Be direct, personal, and value-focused."
            + self._sender_context()
            + self._no_placeholder_rule()
            + " Output ONLY the message text."
        )
        text = await self._call(prompt)
        return text or self._fallback_message(lead_name)

    async def generate_reply(
        self,
        lead_name: str,
        thread: list[dict],
        goal: str = "",
        lead_company: str | None = None,
    ) -> str:
        """
        Write the sender's next reply in an ongoing conversation, driving toward `goal`.
        `thread` is a list of {"direction": "INBOUND"|"OUTBOUND", "body": str} oldest→newest.
        """
        if not self._gemini and not self._anthropic:
            them = next((m["body"] for m in reversed(thread) if m.get("direction") == "INBOUND"), "")
            return self._fallback_reply(lead_name, them)

        convo = "\n".join(
            f"{'Them' if m.get('direction') == 'INBOUND' else 'You'}: {(m.get('body') or '').strip()}"
            for m in thread if (m.get("body") or "").strip()
        )
        prompt = (
            f"You are writing the NEXT LinkedIn message on behalf of the sender, replying to {lead_name}"
            + (f" at {lead_company}" if lead_company else "")
            + "."
            + self._sender_context()
            + (f" Your goal in this conversation: {goal}." if goal else "")
            + "\n\nConversation so far (oldest first):\n" + convo
            + "\n\nWrite ONLY the sender's next reply. Keep it short (1-3 sentences), natural, warm and human. "
            "Directly acknowledge what they just said, then move ONE step toward the goal. "
            "If they show interest, propose a concrete next step — a short call — and suggest a specific way to schedule it. "
            "Do not be pushy or salesy; do not repeat earlier messages."
            + self._no_placeholder_rule()
            + " Output ONLY the message text, no quotes."
        )
        them = next((m["body"] for m in reversed(thread) if m.get("direction") == "INBOUND"), "")
        reply = await self._call(prompt)
        return reply or self._fallback_reply(lead_name, them)

    async def detect_meeting(self, thread: list[dict]) -> dict:
        """
        Classify whether a call/meeting has been AGREED in the conversation.
        Returns {"booked": bool, "detail": str}. Never raises — returns booked=False on any failure.
        """
        if not thread or (not self._gemini and not self._anthropic):
            return {"booked": False, "detail": ""}

        convo = "\n".join(
            f"{'Them' if m.get('direction') == 'INBOUND' else 'You'}: {(m.get('body') or '').strip()}"
            for m in thread if (m.get("body") or "").strip()
        )
        prompt = (
            "Analyze this LinkedIn conversation. Decide if BOTH sides have clearly AGREED to a call/meeting "
            "(one proposed a time or a call and the other accepted, or they mutually agreed to talk). "
            "A vague 'sure let's stay in touch' is NOT a booked call. Only 'yes' if an actual call/meeting is agreed.\n\n"
            f"Conversation:\n{convo}\n\n"
            "Respond in EXACTLY this format, nothing else:\n"
            "BOOKED: yes OR no\n"
            "DETAIL: <one short line with the agreed time/context, or 'none'>"
        )
        try:
            raw = await self._call(prompt)
        except Exception:
            return {"booked": False, "detail": ""}
        booked = False
        detail = ""
        for line in (raw or "").splitlines():
            low = line.strip().lower()
            if low.startswith("booked:"):
                booked = "yes" in low
            elif low.startswith("detail:"):
                detail = line.split(":", 1)[1].strip()
        if detail.lower() in ("none", "n/a", ""):
            detail = ""
        return {"booked": booked, "detail": detail}

    # ── Internal ───────────────────────────────────────────────────────────────

    def _sender_context(self) -> str:
        """Build a 'who is sending this' clause from the saved profile, or '' if empty."""
        s = self._sender or {}
        name    = (s.get("sender_name")    or "").strip()
        role    = (s.get("sender_role")    or "").strip()
        company = (s.get("sender_company") or "").strip()
        about   = (s.get("sender_about")   or "").strip()
        talking = (s.get("sender_talking_points") or "").strip()

        bits: list[str] = []
        if name or role or company:
            who = name or "the sender"
            if role:
                who += f", {role}"
            if company:
                who += f" at {company}"
            bits.append(f"The message is written by {who}")
        if about:
            bits.append(f"About the sender / what they offer: {about}")
        if talking:
            bits.append(f"Key context / talking points to weave in naturally when relevant: {talking}")
        if not bits:
            return ""
        return " Sender details — " + ". ".join(bits) + "."

    def _no_placeholder_rule(self) -> str:
        return (
            " Write from the sender's perspective using ONLY the real details provided; "
            "NEVER output bracketed placeholders like [Your Name], [Company], or [Your Role] — "
            "if a detail is not provided, phrase the sentence so it is not needed."
        )

    async def _call(self, prompt: str) -> str:
        if not self._gemini and not self._anthropic:
            self.last_error = "No AI API key configured — add a Gemini key in Settings → API Keys."
            return ""

        if self._gemini:
            try:
                result = await self._call_gemini(prompt)
                if result:
                    return result
                self.last_error = "Gemini returned an empty response."
            except Exception as exc:
                self.last_error = f"Gemini error: {str(exc)[:300]}"
                app_logger.warning("Gemini call failed, trying Anthropic: %s", exc)

        if self._anthropic:
            try:
                return await self._call_anthropic(prompt)
            except Exception as exc:
                self.last_error = f"Anthropic error: {str(exc)[:300]}"
                app_logger.error("Anthropic call failed: %s", exc)

        return ""

    async def _call_gemini(self, prompt: str) -> str:
        global _WORKING_GEMINI_MODEL
        loop = asyncio.get_event_loop()
        # Try a model we already confirmed works this process first, then the rest.
        models = list(self._gemini_models)
        if _WORKING_GEMINI_MODEL and _WORKING_GEMINI_MODEL in models:
            models = [_WORKING_GEMINI_MODEL] + [m for m in models if m != _WORKING_GEMINI_MODEL]

        last_exc: Exception | None = None
        for name in models:
            try:
                model = self._genai.GenerativeModel(name)
                response = await loop.run_in_executor(None, lambda: model.generate_content(prompt))
                text = (response.text or "").strip()
                if text:
                    _WORKING_GEMINI_MODEL = name  # cache the winner for later calls
                    if text.startswith('"') and text.endswith('"'):
                        text = text[1:-1]
                    return text[:300]
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                msg = str(exc).lower()
                # Model unavailable → try the next candidate. Quota/network → stop and surface it.
                if "404" in msg or "not found" in msg or "not available" in msg or "not supported" in msg:
                    app_logger.warning("Gemini model %s unavailable, trying next: %s", name, str(exc)[:140])
                    continue
                raise
        if last_exc:
            raise last_exc
        return ""

    async def _call_anthropic(self, prompt: str) -> str:
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: self._anthropic.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}],
            ),
        )
        return response.content[0].text.strip()

    # ── Fallback templates ─────────────────────────────────────────────────────

    @staticmethod
    def _fallback_connect(name: str, company: str | None) -> str:
        co = f" at {company}" if company else ""
        return f"Hi {name}, I noticed your work{co} and it caught my attention. I'd love to connect and exchange ideas!"

    @staticmethod
    def _fallback_message(name: str) -> str:
        return f"Hi {name}, I'd love to connect and explore how we might help each other."

    @staticmethod
    def _fallback_reply(name: str, their_message: str) -> str:
        return f"Thanks for the reply, {name}! Would you be open to a quick call to talk more?"
