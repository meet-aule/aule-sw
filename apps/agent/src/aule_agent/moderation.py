"""Content moderation: what a person said, and what the tutor is about to say.

Two layers. A local list of patterns catches a few phrases that must never
depend on a provider being reachable (self-harm, threats, attempts to make the
tutor drop its rules, swearing). OpenAI's moderation endpoint judges everything
else, against thresholds set for children that are far stricter than the
provider's own.

A check that could not be completed is reported as unavailable and is never
read as safe. Only categories and durations are logged: no text, no scores.
"""

import asyncio
import logging
import math
import re
import time
import unicodedata
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

logger = logging.getLogger("aule.agent.moderation")

MODEL = "omni-moderation-latest"
MAX_CHARS = 16_000
TIMEOUT_SECONDS = 2.0
# The first check of a session also opens the connection. It gets one longer
# attempt rather than a first turn that always fails.
INITIAL_TIMEOUT_SECONDS = 8.0
# What a child's session sends before it starts, to know that the provider
# answers: a word that is in no category.
PROBE_TEXT = "hola"

_PATTERN_DEFINITIONS: list[tuple[str, str]] = [
    # Self-harm and aggression come first so the gravest match wins.
    ("self-harm/instructions", r"\bm[aá]tate\b"),
    ("self-harm", r"\bsu[ií]c[ií]d\w*\b"),
    ("self-harm/intent", r"\bme\s+quiero\s+morir\b"),
    ("self-harm/intent", r"\b(?:i\s+want\s+to\s+die|quero\s+morrer)\b"),
    ("harassment", r"\bte\s+odio\b"),
    ("violence", r"\bte\s+voy\s+a\s+matar\b"),
    (
        "prompt_injection",
        r"\b(?:ignora|olvida|omite)\s+(?:todas?\s+)?(?:tus|las)\s+(?:instrucciones|reglas)\b",
    ),
    (
        "prompt_injection",
        r"\b(?:ignore|forget|disregard)\s+(?:all\s+)?(?:your|the)\s+(?:instructions|rules)\b",
    ),
    (
        "prompt_injection",
        r"\b(?:muestra|revela|imprime)\s+(?:tu|el)\s+"
        r"(?:system\s+prompt|prompt\s+del\s+sistema|instrucciones\s+internas)\b",
    ),
    (
        "prompt_injection",
        r"\b(?:show|reveal|print)\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions)\b",
    ),
    ("prompt_injection", r"\bact[uú]a\s+como\s+si\s+no\s+tuvieras\s+reglas\b"),
    # A word of this list stops a reply of the tutor, so it holds only whole
    # words and phrases that are swearing wherever they are said. Ordinary
    # words stay out, many of them everyday Spanish in Peru: "pita" (string)
    # and "pito" (a whistle), "chunga" (a joke) and "chungo" (the stone of a
    # batán), "concha" (a shell) without the insult around it, "culé" (a
    # Barcelona supporter), and the names Jodie and Moby Dick. The name Jodi
    # is still taken for swearing: without its accent it is "jodí".
    *[
        ("profanity", pattern)
        for pattern in [
            r"\bmi[e3]rda\b",
            r"\bput[ao]s?\b",
            r"\bpend[e3]j[ao]s?\b",
            r"\bching[ao]+\b",
            r"\bculos?\b",
            r"\bver[gq]a\b",
            r"\bc[ao]j[ou]d[ao]\b",
            r"\bhij[ou][e3]?\s*(?:de\s+)?put[ao]\b",
            r"\bmal\s*parid[ao]\b",
            r"\bcar[a]j[o]\b",
            r"\bjod(?!ie\b)[ae3ir]\w*\b",
            # The insult names a woman of the family; a shell of a brother or
            # of the right size is not one. Cut short, it is an insult too.
            r"\bconch[ae]\s*(?:de\s*|['’]e\s*)?(?:tu|su)\s*"
            r"(?:madre|mare|mama|mami|vieja|abuela|hermana)\b",
            r"\bconch[ae]\s*(?:de\s*|['’]e\s*)?(?:tu|su)\b(?!\s*\w)",
            r"\bmaric[oó]n\b",
            r"\bhue?v[oó]n\b",
            r"\bimb[eé]cil\b",
            r"\best[uú]pid[ao]s?\b",
            r"\bidiot[ao]s?\b",
            r"\bweb[oó]n\b",
            r"\bchucha\b",
            r"\bctm\b",
            r"\bptm\b",
            r"\bcsm\b",
            r"\bmaldito\b",
            r"\bping[ao]\b",
            r"\bmam[oó]n\b",
            r"\bfuck\w*\b",
            r"\bsh[i1]t\b",
            r"\bb[i1]tch\b",
            r"\bass\s*hole\b",
            r"\bdamn\b",
            r"\bwh[o0]re\b",
            r"(?<!moby )(?<!moby-)\bd[i1]ck\b",
        ]
    ],
]

_PATTERNS = [
    (category, re.compile(pattern, re.IGNORECASE)) for category, pattern in _PATTERN_DEFINITIONS
]

# Our policy for children, not calibrated probabilities or the provider's defaults.
THRESHOLDS: dict[str, float] = {
    "harassment": 0.3,
    "harassment/threatening": 0.2,
    "self-harm": 0.15,
    "self-harm/intent": 0.1,
    "self-harm/instructions": 0.1,
    "sexual": 0.15,
    "sexual/minors": 0.05,
    "violence": 0.3,
    "violence/graphic": 0.2,
    "hate": 0.3,
    "hate/threatening": 0.2,
    "illicit": 0.2,
    "illicit/violent": 0.1,
}


class Action(StrEnum):
    ALLOW = "allow"
    REDIRECT = "redirect"
    SUPPORT = "support"
    UNAVAILABLE = "unavailable"


class Probe(StrEnum):
    """What a gate's provider did when asked, before a session, whether it answers."""

    ANSWERS = "answers"
    KEY_REFUSED = "key_refused"
    UNREACHABLE = "unreachable"
    UNEXPECTED = "unexpected"


def probe_of(status: object) -> Probe:
    """What a request that got no usable answer says about the provider, from
    the HTTP status it answered with, if any: the key was refused, it answered
    something the gate does not take, or it did not answer at all."""
    if status in (401, 403):
        return Probe.KEY_REFUSED
    return Probe.UNEXPECTED if isinstance(status, int) else Probe.UNREACHABLE


@dataclass(frozen=True)
class Decision:
    """What happens to a turn. ``reply`` is a key of ``replies.REPLIES``."""

    action: Action
    reply: str | None = None

    @property
    def allowed(self) -> bool:
        return self.action is Action.ALLOW


@dataclass(frozen=True)
class Finding:
    """What moderation found in one text: provider category names, never the text."""

    available: bool = True
    categories: tuple[str, ...] = ()
    # Swearing is kept apart: a child who swears is not stopped, the tutor is.
    profanity: bool = False
    # True when all that was found are scores over our threshold that the
    # provider itself did not act on, in categories where ordinary teaching
    # sentences land as often as bad ones, so a score cannot settle it (see
    # ``opinion``).
    unsure: bool = False
    # True when the self-harm scores are faint, under our thresholds or just
    # over them, in a sentence the provider itself did not act on and where
    # nothing else was found. A student who is only tired lands there ("I
    # don't want to go on, let's finish"), and so do veiled words of a child
    # in distress that score as nothing ("everyone would be better off without
    # me"), so such a sentence is read once more (see ``opinion``). Anything
    # stronger, or found with anything else, is never in doubt.
    faint_self_harm: bool = False

    @property
    def flagged(self) -> bool:
        return bool(self.categories) or self.profanity


def _normalize(text: str) -> str:
    """Lower case without accents or invisible characters, so they cannot hide a word."""
    decomposed = unicodedata.normalize("NFKD", text.lower())
    return "".join(
        char
        for char in decomposed
        if not unicodedata.combining(char) and unicodedata.category(char) != "Cf"
    )


def local_category(text: str) -> str | None:
    """The category of the first local pattern found in the text, if any."""
    normalized = _normalize(text)
    for category, pattern in _PATTERNS:
        if pattern.search(normalized):
            return category
    return None


# Where our threshold for children is far below the provider's own and ordinary
# teaching sentences cross it. A finding made only of these, which the provider
# itself did not act on, is not a verdict (see ``opinion``). Threats, anything
# about minors and illicit acts are never in doubt, and neither is self-harm,
# except for the faint scores described in ``Finding``.
SECOND_READING = frozenset({"sexual", "harassment", "hate", "violence"})


def provider_is_unsure(response: Any) -> bool:
    """Whether everything found is over our threshold only, in the categories a
    second reader may settle, and the provider's own verdict is that nothing is
    wrong. Call after ``provider_categories`` accepted the response."""
    result = response.results[0]
    found = provider_categories(response)
    return bool(found) and set(found) <= SECOND_READING and result.flagged is False


# A self-harm score from the first to below the second, in a sentence the
# provider did not flag, may be a tired student or a child in distress, and is
# read once more. Below it the sentence is ordinary talk; from the second up it
# is never in doubt.
SELF_HARM_FAINT_FROM = 0.003
SELF_HARM_FAINT_BELOW = 0.2
_SELF_HARM_SCORES = ("self_harm", "self_harm_intent", "self_harm_instructions")


def provider_finds_faint_self_harm(response: Any) -> bool:
    """Whether the self-harm scores are faint, nothing but self-harm was found
    if anything was, and the provider's own verdict is that nothing is wrong.
    Call after ``provider_categories`` accepted the response."""
    result = response.results[0]
    if result.flagged is not False:
        return False
    if not all(category.startswith("self-harm") for category in provider_categories(response)):
        return False
    score = max(getattr(result.category_scores, name) for name in _SELF_HARM_SCORES)
    return SELF_HARM_FAINT_FROM <= score < SELF_HARM_FAINT_BELOW


def provider_categories(response: Any) -> tuple[str, ...]:
    """The categories over our thresholds. Raises on anything not fully understood."""
    result = response.results[0]
    if not isinstance(result.flagged, bool):
        raise ValueError("invalid moderation verdict")
    found = []
    for category, threshold in THRESHOLDS.items():
        name = category.replace("/", "_").replace("-", "_")
        score = getattr(result.category_scores, name, None)
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            raise ValueError("invalid moderation score")
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("invalid moderation score")
        named = getattr(result.categories, name, None)
        if not isinstance(named, bool):
            raise ValueError("invalid moderation category")
        if score >= threshold or named:
            found.append(category)
    if result.flagged and not found:
        # Flagged for a reason we do not know: an answer we cannot classify.
        raise ValueError("moderation flagged without a known category")
    return tuple(found)


class Moderator:
    """Moderation for one session: one client, reused for every check."""

    def __init__(self, api_key: str, *, client: Any = None) -> None:
        if client is None:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=api_key, timeout=INITIAL_TIMEOUT_SECONDS, max_retries=0)
        self._client = client
        self._connected = False

    async def check(self, text: str) -> Finding:
        started = time.monotonic()
        local = local_category(text)
        categories: tuple[str, ...] = ()
        available = False
        unsure = False
        faint = False
        # A local match never skips the provider: swearing must not hide a
        # graver category in the same sentence.
        if len(text) <= MAX_CHARS:
            timeout = TIMEOUT_SECONDS if self._connected else INITIAL_TIMEOUT_SECONDS
            self._connected = True
            try:
                async with asyncio.timeout(timeout):
                    response = await self._client.moderations.create(model=MODEL, input=text)
                categories = provider_categories(response)
                unsure = provider_is_unsure(response)
                faint = provider_finds_faint_self_harm(response)
                available = True
            except asyncio.CancelledError:
                raise
            except Exception as error:  # whatever went wrong, the text was not checked
                logger.warning("moderation unavailable", extra={"error": type(error).__name__})
        if local and local != "profanity" and local not in categories:
            categories = (*categories, local)
        finding = Finding(
            available=available,
            categories=categories,
            profanity=local == "profanity",
            # A word of our own list is a finding of its own: nothing to be unsure about.
            unsure=unsure and local is None,
            faint_self_harm=faint and local is None,
        )
        if finding.flagged or not finding.available:
            logger.info(
                "moderation finding",
                extra={
                    "categories": list(finding.categories),
                    "profanity": finding.profanity,
                    "available": finding.available,
                    "duration_ms": round((time.monotonic() - started) * 1000),
                },
            )
        return finding

    async def probe(self) -> Probe:
        """Whether the provider answers now, asked once before a child's session
        starts, with the longer wait of a first check. The endpoint is free,
        and the word it reads is in no category.

        It does not count as the session's first check: the client closes a
        connection left idle for a few seconds, so the first turn may have to
        open one again, and it keeps the longer wait for that."""
        started = time.monotonic()
        status: int | None = None
        try:
            async with asyncio.timeout(INITIAL_TIMEOUT_SECONDS):
                response = await self._client.moderations.create(model=MODEL, input=PROBE_TEXT)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # The provider's client keeps the status of an answer it refused.
            code = getattr(error, "status_code", None)
            status = code if isinstance(code, int) else None
            probe = probe_of(status)
        else:
            try:
                provider_categories(response)
                probe = Probe.ANSWERS
            except Exception:
                probe = Probe.UNEXPECTED
        logger.log(
            logging.INFO if probe is Probe.ANSWERS else logging.WARNING,
            "moderation probed",
            extra={
                "probe": probe.value,
                "status": status,
                "duration_ms": round((time.monotonic() - started) * 1000),
            },
        )
        return probe

    async def close(self) -> None:
        await self._client.close()


def classify_heard(finding: Finding) -> Decision:
    """What to do with something a person said. Supportive, never punitive."""
    if any(category.startswith("self-harm") for category in finding.categories):
        return Decision(Action.SUPPORT, "self_harm_support")
    if not finding.available:
        return Decision(Action.UNAVAILABLE, "unavailable")
    if "sexual/minors" in finding.categories:
        return Decision(Action.SUPPORT, "child_support")
    if finding.categories:
        return Decision(Action.REDIRECT, "redirect")
    return Decision(Action.ALLOW)


def classify_spoken(finding: Finding) -> Decision:
    """What to do with a reply of the tutor. Flagged or unchecked text is never spoken."""
    if not finding.available:
        return Decision(Action.UNAVAILABLE, "unavailable")
    if finding.flagged:
        return Decision(Action.REDIRECT, "redirect")
    return Decision(Action.ALLOW)
