"""The questions a model asks of its own while a question of the engine's is
open, a reply without them, and that open question.

In a session the engine runs, the engine asks: its steps are the exercise,
and its «¿Seguimos?» is what moves a lesson on. The model is only called to
answer what the student said. Its rules tell it to set no task of its own and
to ask nothing with a right answer, and it asked anyway (2026-11-27, by
voice: 27 of its 37 replies ended in a question of its own, «Ahora te toca a
ti: ¿cuánto es 1/4 + 2/4?»). A child answers whoever asked last: «Tres
cuartos» went to the model again, which asked again, and the lesson only
moved when the engine gave up waiting, at the third turn. Twelve turns of
talk in a row, one block of the lesson every three, and the engine's own
question never heard again.

So while a question of the engine's is open, a question of the model's is
not said, nor a task it sets («explícame cómo…», «ahora te toca a ti»), and
the reply ends with the engine's question, as the engine wrote it: the child
hears the answer to what they said, and then where the session is. By rule,
like the goodbyes (``closing``): what is left out must not depend on the
model that wrote it.
"""

import re

from .closing import SENTENCE, plain

# Read without accents and in lower case: a task set without a question mark.
_SETS_A_TASK = re.compile(
    "|".join(
        (
            r"\bte toca\b",
            r"\bahora vamos a\b",
            r"\bmira este ejercicio\b",
            r"\b(explicame|cuentame|dime|muestrame|respondeme|pasame)\b",
            r"\b(your turn|now you try)\b",
            r"\b(tell me|explain to me|show me)\b",
        )
    )
)


def asks(sentence: str) -> bool:
    """Whether the sentence asks the student for an answer: a question, or a
    task set without one."""
    return "?" in sentence or _SETS_A_TASK.search(plain(sentence)) is not None


def without(reply: str) -> str:
    """The reply without the sentences that ask the student for an answer;
    the reply itself, untouched, when it has none. Empty when it was nothing
    else."""
    sentences = SENTENCE.findall(reply)
    kept = [sentence for sentence in sentences if not asks(sentence)]
    if len(kept) == len(sentences):
        return reply
    return "".join(kept).strip()


def question(line: str) -> str | None:
    """The question a line of the engine's leaves open: from its last «¿» to
    its end («¿Qué fracción de tus canicas son azules? Dila simplificada.»),
    or its last sentence where the language opens no question mark. None when
    the line asks nothing."""
    start = line.rfind("¿")
    if start >= 0:
        return line[start:].strip()
    sentences = SENTENCE.findall(line)
    last = sentences[-1].strip() if sentences else ""
    return last if last.endswith("?") else None
