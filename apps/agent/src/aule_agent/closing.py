"""The sentences with which a tutor closes a session, and a reply without them.

In a session the engine runs, the engine ends it: its last lines are its
goodbye, and a student's own goodbye is answered with a fixed line. The model
is only asked while the session goes on, yet it closed sessions by itself
(2026-11-26, by voice: «Por hoy cerramos aquí… ¡Hasta pronto!» at the
thirteenth turn of a session the engine was still teaching, and twelve such
replies in forty). A child who answers «nos vemos» to that ends the session,
and one who does not is told again and again that it is over.

So a sentence that says goodbye, says the session is over, puts the work off
to another day or sends the student away to rest is not said. By rule, as the
student's own goodbye is read (``farewell``): what is left out must not
depend on the model that wrote it.

Nor is a sentence that sums up the day («Hoy trabajaste las fracciones
equivalentes y la comparación… ¡Buen trabajo hoy!»). Told not to say goodbye,
the model summed the day up instead: thirteen such replies in one session by
voice (2026-11-26), most of them to a child stuck at a step, who was told what
had been done today when the step was still to do.
"""

import re
import unicodedata

# A sentence, with the space before it: up to its closing marks, or to the end.
SENTENCE = re.compile(r"[^.!?…]*[.!?…]+[\"'»”)\]]*|[^.!?…]+$")

# Read without accents and in lower case. Each is a way of closing, not a
# word: «la próxima vez» alone is advice («la próxima vez cuenta primero el
# total»), and "I see you counted five" is no goodbye.
_CLOSES = re.compile(
    "|".join(
        (
            # Spanish: goodbye.
            r"\bhasta (pronto|luego|manana|la proxima|la vista|otro dia|otra)\b",
            r"\bnos vemos\b",
            r"\b(chau|chao|chaito|adios)\b",
            r"\bcuidate\b",
            # Sent away to rest.
            r"\bque descanses\b",
            r"\bdescansa\b",
            r"\bte dejo descansar\b",
            r"\b(tomemos|toma|tomate|hagamos) un descanso\b",
            # The session is over.
            r"\bpor hoy\b",
            r"\bhoy (ya )?(cerramos|terminamos|acabamos)\b",
            r"\b(la sesion|la clase) "
            r"(termina|termino|acaba|acabo|se acaba|se acabo|ha terminado)\b",
            r"\b(terminamos|cerramos|acabamos|lo dejamos) (aqui|la sesion|la clase)\b",
            # Put off to another day.
            r"\bproxima (sesion|clase)\b",
            r"\b(para|hasta|en) la proxima vez\b",
            r"\bla proxima vez "
            r"(seguimos|continuamos|vemos|hacemos|practicamos|trabajamos|te traigo)\b",
            r"\b(seguiremos|continuaremos|practicaremos|veremos|seguimos|continuamos)\b"
            r"[^.!?]*\bla proxima vez\b",
            r"\b(seguimos|continuamos|lo vemos) (manana|otro dia)\b",
            r"\bcuando (quieras|vuelvas)\b[^.!?]*\b(seguimos|continuamos)\b",
            r"\b(seguimos|continuamos)\b[^.!?]*\bcuando (quieras|vuelvas)\b",
            # English: goodbye.
            r"\b(goodbye|good bye|bye|farewell)\b",
            r"\bsee you (soon|later|next|tomorrow|again|then)\b",
            r"\b(until|till) next time\b",
            r"\btake care\b",
            # Sent away to rest.
            r"\b(get some rest|have a rest|rest well|take a break|take a rest)\b",
            # The session is over.
            r"\bfor today\b(?!['’]s)",
            r"\b(we are|we're) (done|finished)\b",
            r"\b(the|our) (session|lesson|class) (is over|is finished|ends|has ended)\b",
            r"\b(stop|finish|end|leave it) here\b",
            # Put off to another day.
            r"\bnext (session|lesson|class)\b",
            r"\bnext time we\b",
            r"\b(continue|carry on|pick (it|this) up|keep going)\b"
            r"[^.!?]*\b(next time|tomorrow|another day)\b",
            r"\bwhen(ever)? you (are ready|come back|want)\b[^.!?]*\b(continue|carry on|go on)\b",
            r"\b(continue|carry on|go on)\b[^.!?]*\bwhen(ever)? you (are ready|come back|want)\b",
        )
    )
)

# The day summed up, in the past: «hoy vamos a trabajar fracciones» opens a
# session and «la pizza de hoy» only names it. A question is never one.
_DID = (
    r"(trabajaste|practicaste|aprendiste|descubriste|lograste|repasaste|avanzaste|hiciste|viste"
    r"|trabajamos|practicamos|aprendimos|descubrimos|repasamos|avanzamos|hicimos|vimos)"
)
_SUMS_UP = re.compile(
    "|".join(
        (
            # Spanish.
            rf"(?<!\bde )\bhoy (ya )?(lo |la |los |las )?{_DID}\b",
            r"(?<!\bde )\bhoy te costo\b",
            rf"\blo que (hoy {_DID}|{_DID} hoy)\b",
            r"\b(lo principal|lo importante|lo mas importante|la idea|el resumen)\b"
            r"[^.!?]*\bde hoy\b",
            r"\b(nos llevamos|te llevas) hoy\b",
            r"\b(trabajo|esfuerzo|trabajado|hecho) (de )?hoy\b",
            r"\bsigue practicando\b",
            # English.
            r"\btoday (you|we) (worked|practi[cs]ed|learned|learnt|discovered|saw|did|covered)\b",
            r"\bwhat (you|we) (worked on|practi[cs]ed|learned|learnt|did|saw|covered) today\b",
            r"\b(work|job|effort) today\b",
            r"\bkeep practi[cs]ing\b",
        )
    )
)


def plain(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text.lower())
    return "".join(letter for letter in decomposed if unicodedata.category(letter) != "Mn")


def closes(sentence: str) -> bool:
    """Whether the sentence closes the session: a goodbye, the session said to
    be over, the work put off to another day, the student sent to rest, or the
    day summed up."""
    read = plain(sentence)
    if _CLOSES.search(read) is not None:
        return True
    return "?" not in sentence and _SUMS_UP.search(read) is not None


def without(reply: str) -> str:
    """The reply without the sentences that close the session; the reply
    itself, untouched, when it has none. Empty when it was nothing else."""
    sentences = SENTENCE.findall(reply)
    kept = [sentence for sentence in sentences if not closes(sentence)]
    if len(kept) == len(sentences):
        return reply
    return "".join(kept).strip()
