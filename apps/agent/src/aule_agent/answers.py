"""What of a child's turn goes to the exercise checker, decided without a model.

The checker is the platform's reader of answers (``apps/platform/src/exercise.rs``).
It takes one number out of whatever it is sent, and today it reads some things
wrong: "treinta y uno" as 30, "un", "una", "a" and "an" as 1, the first number
of an exercise said again as the answer, and a question that uses the
exercise's numbers as a wrong try. So only two kinds of turn are sent, in a
form it reads right:

- a plain request for help with the exercise ("no sé", "no entiendo", "I
  don't understand", "dame una pista"), sent as the fixed "no sé" or "I don't
  know";
- an answer written in digits, sent as the child wrote it, without the
  exercise when they said it again.

Everything else stays with the model, which checks it itself: a question, a
number said in words, reasoning that reuses the exercise's own numbers or the
values of its steps, a negative number, an answer to anything but plain
arithmetic. So does anything said with a request for help that is not about
the exercise: "ayúdame, tengo miedo", "no se escucha nada", "gracias, eso me
ayuda", "no sé, mi mamá dice que soy tonto". To the platform a "no sé" is a
hint spent, or a probe failed, so a line is sent as one only when it says
nothing else. Each limit can be lifted once the platform reads that case
right.

``names_other_numbers`` reads the tutor's side: a reply that names numbers
other than the exercise's own, or the values of its steps, asks about another
computation (a worked example, a simpler one, a question of its own), and the
child's next turn answers that, not the exercise.

Pure: no IO, and nothing here logs.
"""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from math import gcd
from typing import Literal

Kind = Literal["help", "answer", "left"]

# The longest text the platform takes as an answer.
MAX_SAID_CHARS = 500
# What a request for help is sent as. The platform reads both as "no sé".
HELP_SENT = {"es": "no sé", "en": "I don't know"}


@dataclass(frozen=True)
class Reading:
    """What goes to the checker for one turn: ``said`` is None when nothing
    does. ``restated`` tells whether the child wrote the exercise again."""

    said: str | None
    kind: Kind
    restated: bool


# Written without accents and in lower case, as the platform compares them, on
# whole words. Only what says plainly that the child does not know or does not
# understand, or asks for a hint: "ayuda", "help", "no puedo", "I can't", "no
# me sale" and "no te entiendo" are said of a fright, a sore tummy, a broken
# screen or the tutor's voice as often as of an exercise.
HELP_PHRASES = (
    "no lo se",
    "ni idea",
    "no tengo idea",
    "no tengo ni idea",
    "no entiendo",
    "no lo entiendo",
    "no le entiendo",
    "no comprendo",
    "no lo comprendo",
    "no puedo hacerlo",
    "una pista",
    "i don t know",
    "i dont know",
    "i do not know",
    "don t understand",
    "dont understand",
    "do not understand",
    "don t get it",
    "dont get it",
    "no idea",
    "i can t do it",
    "i cant do it",
    "i cannot do it",
    "a hint",
)
# The phrases as words, longest first.
_HELP = sorted((tuple(phrase.split()) for phrase in HELP_PHRASES), key=len, reverse=True)
# "no sé" counts where it says that: at the end of what is said, or before
# what is not known ("no sé cómo"). Before a verb it is another "se": "no se ve
# bien", "no se escucha", "no se suman los de abajo".
_NO_SE_THEN = frozenset(
    "que como cuanto cuanta cual hacer hacerlo resolverlo nada bien muy todavia aun".split()
)
# Thanks, a wish to do it alone, a question of why, or words about the tutor's
# voice: never a request for help with the exercise, whatever else is said.
_NOT_HELP = (
    "gracias",
    "thanks",
    "thank you",
    "sin ayuda",
    "without help",
    "por que",
    "why",
    "te entiendo",
    "understand you",
)
# What may be said with a request for help, besides it, without making it about
# something else: a few small words, the exercise and its parts, asking for it
# to be explained another way, and the things an explanation is made of. Any
# other word ("miedo", "pantalla", "mamá", "scared", "tummy") leaves the turn
# to the model.
_WITH_HELP = frozenset(
    (
        # Spanish: small words.
        "a al ah ay eh mm mmm uhm um oye profe pues bueno ya aun todavia el la lo los las le "
        "me mi este esta esto eso ese esa aqui de del en con y o pero que como cual cuanto si "
        "no nada bien muy mucho verdad creo porfa porfis por favor perdon otra otro vez un "
        "una algo es son asi se "
        # Spanish: the exercise and doing it.
        "ejercicio problema pregunta operacion cuenta calculo suma resta multiplicacion "
        "division fraccion fracciones paso pasos parte tema tarea hace hago hacer hacerlo "
        "resolver resolverlo empezar seguir "
        # Spanish: explain it another way.
        "explica explicas explicame explicamelo explicarme explicarmelo explicalo explicar "
        "puedes podrias dame das darme ayudas ayudame ayuda ayudar ayudarme muestrame "
        "ensename ensenarme dibuja dibujame dibujo ejemplo ejemplos pista pistas manera "
        "forma idea facil sencillo simple despacio nuevo repite repitelo mejor distinto "
        "diferente vida real cosas objetos pizza pizzas torta chocolate caramelos dulces "
        "figuritas plata dinero soles monedas frutas manzanas galletas "
        # English: small words.
        "i um uh hmm oh ah well so the this that it an at all really still yet sorry "
        "please pls plz and but or just think how what which to do anything here yes ok "
        "okay again me my about of with from in on is "
        # English: the exercise and doing it.
        "exercise problem question sum step steps part homework start "
        # English: explain it another way.
        "explain can could would you give have show draw picture drawing example examples "
        "hint hints another way easier simpler simple easy slowly slower different "
        "differently something idea by help real life like things objects pizza pizzas "
        "cake chocolate sweets candy candies money coins apples fruit cookies stickers"
    ).split()
)
# "más" only as in "más fácil": "no puedo hacerlo más" is not about the exercise.
_MORE_OF = frozenset("facil sencillo simple despacio lento claro".split())
# A question that only asks whether the answer before it is right.
_TAG = re.compile(
    r"[\s,.;:]*¿?\s*(?:esta bien|verdad|cierto|si|no|es asi|is that right|is it right|"
    r"right|correct|is that correct|ok|okay)\s*\?\s*$"
)
# The numbers the platform reads in digits: a fraction of whole numbers, a
# decimal with a point or a comma, a whole number.
_NUMBER = re.compile(r"[0-9]+\s*/\s*[0-9]+|[0-9]+[.,][0-9]+|[0-9]+")
_TOKEN = re.compile(r"[0-9]+\s*/\s*[0-9]+|[0-9]+[.,][0-9]+|[0-9]+|[^\W\d_]+|=")
# A word, or a mark that ends what is said or a part of it.
_SAID = re.compile(r"[^\W\d_]+|[.,;:!?¡¿…\n]")
_MARKS = frozenset(".,;:!?¡¿…\n")
_NEGATIVE = re.compile(r"(?:-|\bmenos|\bminus)\s*$")
# The largest whole number the platform reads; a longer one is a word to it.
_LARGEST = 2**63 - 1
# A decimal with more figures than this is a word to the platform.
_DECIMALS = 6

# What the platform's ``plain`` makes of a text before reading it.
_PLAIN = str.maketrans(
    {
        **dict.fromkeys("áàä", "a"),
        **dict.fromkeys("éèë", "e"),
        **dict.fromkeys("íìï", "i"),
        **dict.fromkeys("óòö", "o"),
        **dict.fromkeys("úùü", "u"),
        **dict.fromkeys("⁄∕", "/"),
        **dict.fromkeys("×·", "*"),
        "÷": ":",
        **dict.fromkeys("−–", "-"),
    }
)

# The words the platform's reader takes for a number (``cardinal`` and
# ``parts`` in exercise.rs), articles included, and the words after which it
# looks for the answer (``Marker``).
_ARTICLES = frozenset({"un", "una", "a", "an"})
_SMALL = (
    "cero uno dos tres cuatro cinco seis siete ocho nueve diez zero one two three four five six "
    "seven eight nine ten"
).split()
_LARGE = (
    "once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte veintiuno "
    "veintidos veintitres veinticuatro veinticinco veintiseis veintisiete veintiocho veintinueve "
    "treinta cuarenta cincuenta sesenta setenta ochenta noventa cien eleven twelve thirteen "
    "fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy "
    "eighty ninety hundred"
).split()
_CARDINALS = frozenset(_SMALL + _LARGE)
_PARTS = frozenset(
    (
        "medio media mitad mitades tercio tercera cuarto cuarta quinto quinta sexto sexta septimo "
        "septima octavo octava noveno novena decimo decima centesimo half halve third quarter "
        "fourth fifth sixth seventh eighth ninth tenth"
    ).split()
)
# "onceavos", "veinteavos": a number above ten with "avo".
_AVO_STEMS = frozenset(_LARGE)
_MARKERS = frozenset(
    {"es", "da", "sale", "igual", "resultado", "queda", "son", "is", "equals", "makes", "="}
)

# How the signs of an exercise may be written again: "3 x 4", "3×4", "3 * 4".
_SIGNS = {
    "+": r"\+",
    **dict.fromkeys("-−–", "[-−–]"),
    **dict.fromkeys("*x×·", "[*x×·]"),
    **dict.fromkeys(":÷", "[:÷]"),
    **dict.fromkeys("/⁄∕", "[/⁄∕]"),
    "(": r"\(",
    ")": r"\)",
}
_PIECE = re.compile(r"[0-9]+(?:[.,][0-9]+)?|\S")


def to_check(words: str, expression: str, language: str) -> Reading:
    """What of ``words``, a turn that passed every input gate, goes to the
    checker while ``expression`` is the exercise open."""
    exercise = _exercise(expression)
    rest, restated = words, False
    if exercise is not None and (found := exercise.search(words)) is not None:
        rest, restated = f"{words[: found.start()]} {words[found.end() :]}", True
    rest = " ".join(rest.split())
    if not _NUMBER.search(rest):
        if _asks_for_help(rest):
            return Reading(HELP_SENT[language], "help", restated)
        return Reading(None, "left", restated)
    if exercise is None:
        # Algebra, or anything else that is not plain arithmetic: its answers
        # are read another way, and the model passes them.
        return Reading(None, "left", restated)
    said = _last_chars(rest)
    core = _TAG.sub("", _plain(said))
    if "?" in core or "¿" in core:
        return Reading(None, "left", restated)
    numbers = list(_NUMBER.finditer(core))
    if len(numbers) != 1:
        return Reading(None, "left", restated)
    number = numbers[0]
    value = _value(number.group())
    if (
        value is None
        or value in _own_numbers(expression)
        or _NEGATIVE.search(core[: number.start()])
        or _read_first(said) != "digits"
    ):
        return Reading(None, "left", restated)
    return Reading(said, "answer", restated)


def _plain(text: str) -> str:
    return text.lower().translate(_PLAIN)


def _exercise(expression: str) -> re.Pattern[str] | None:
    """The exercise as a child may write it again: with any spacing, and its
    signs in any of their forms. None when it is not plain arithmetic."""
    # "6 × 4 = ?" is still 6 × 4, as the platform reads it.
    pieces = _PIECE.findall(re.sub(r"[\s=?]+$", "", expression.lower()))
    parts = []
    for index, piece in enumerate(pieces):
        if _is_digits(piece):
            parts.append(re.sub(r"[.,]", "[.,]", piece))
            continue
        if piece not in _SIGNS:
            return None
        if piece == "x" and not (
            0 < index < len(pieces) - 1
            and (_is_digits(pieces[index - 1]) or pieces[index - 1] == ")")
            and (_is_digits(pieces[index + 1]) or pieces[index + 1] == "(")
        ):
            # An unknown, not a sign: "2x + 3 = 11".
            return None
        parts.append(_SIGNS[piece])
    if len(pieces) < 2 or not any(_is_digits(piece) for piece in pieces):
        return None
    body = r"\s*".join(parts)
    return re.compile(rf"(?<![0-9])(?<![0-9][.,]){body}(?![0-9]|[.,][0-9])", re.IGNORECASE)


def _is_digits(piece: str) -> bool:
    return piece[0] in "0123456789"


def _asks_for_help(text: str) -> bool:
    """Whether ``text``, which holds no digit, plainly asks for help with the
    exercise: it says a help phrase, and nothing it says besides goes beyond
    the words that may go with one."""
    said = _SAID.findall(_plain(text))
    words = [token for token in said if token not in _MARKS]
    if any(_is_number_word(word) and word not in _ARTICLES for word in words):
        # A number said in words, an answer perhaps: the model reads it.
        return False
    joined = f" {' '.join(words)} "
    if any(f" {phrase} " in joined for phrase in _NOT_HELP):
        return False
    asked, others, at = False, [], 0
    while at < len(said):
        length = _help_at(said, at)
        if length:
            asked, at = True, at + length
            continue
        token = said[at]
        at += 1
        if token == "mas" and at < len(said) and said[at] in _MORE_OF:
            continue
        if token not in _MARKS:
            others.append(token)
    return asked and all(word in _WITH_HELP for word in others)


def _help_at(said: list[str], at: int) -> int:
    """How many tokens of ``said`` from ``at`` make a help phrase; 0 for none."""
    for phrase in _HELP:
        if tuple(said[at : at + len(phrase)]) == phrase:
            return len(phrase)
    if said[at : at + 2] == ["no", "se"]:
        then = said[at + 2] if at + 2 < len(said) else "."
        if then in _MARKS or then in _NO_SE_THEN:
            return 2
    return 0


def _is_number_word(word: str) -> bool:
    if word in _ARTICLES or word in _CARDINALS or word in _PARTS:
        return True
    singular = word.removesuffix("s")
    if singular in _PARTS:
        return True
    stem = singular.removesuffix("avo")
    return stem != singular and (stem in _AVO_STEMS or f"{stem}e" in _AVO_STEMS)


def _last_chars(text: str) -> str:
    """The last characters the platform takes, from the start of a word."""
    if len(text) <= MAX_SAID_CHARS:
        return text
    cut = text[-MAX_SAID_CHARS:]
    if not text[-MAX_SAID_CHARS - 1].isspace():
        cut = cut.partition(" ")[2]
    return cut.strip()


def _value(written: str) -> Fraction | None:
    """The value of a number in digits, or None when the platform cannot read it."""
    if "/" in written:
        top, bottom = (int(part) for part in written.split("/"))
        if bottom == 0 or max(top, bottom) > _LARGEST:
            return None
        return Fraction(top, bottom)
    whole, _, decimals = written.replace(",", ".").partition(".")
    if int(whole) > _LARGEST or len(decimals) > _DECIMALS:
        return None
    return Fraction(f"{whole}.{decimals}" if decimals else whole)


def _own_numbers(expression: str) -> set[Fraction]:
    """The exercise's numbers and their whole parts, and the values of its
    steps: what an explanation of it repeats, or what a child answers to a
    smaller step they were asked ("¿cuánto es 3 por 2?"), so a lone one of
    them is never taken for the answer."""
    own: set[Fraction] = set()
    for written in _NUMBER.findall(_plain(expression)):
        value = _value(written)
        if value is not None:
            own.add(value)
        own.update(Fraction(int(whole)) for whole in re.findall(r"[0-9]+", written))
    return own | _steps(expression)


# A value worked out, and its top and bottom when it is a whole number or a
# fraction of whole numbers as written in the exercise.
_Operand = tuple[Fraction, tuple[int, int] | None]


def _steps(expression: str) -> set[Fraction]:
    """The values a child works out on the way to the exercise's answer, the
    answer itself left out: each operation's result (3 × 2 in 25 + 3 × 2); in a
    sum of fractions the product and the least common multiple of the bottoms,
    each top over them and the new top; in a division by a fraction its
    reciprocal, and the product of the tops and of the bottoms. Empty when the
    exercise is not plain arithmetic."""
    pieces = _PIECE.findall(re.sub(r"[\s=?]+$", "", _plain(expression)))
    steps: set[Fraction] = set()
    at = 0

    def next_is(*signs: str) -> bool:
        return at < len(pieces) and pieces[at] in signs

    def take() -> str:
        nonlocal at
        at += 1
        return pieces[at - 1]

    def operand() -> _Operand:
        nonlocal at
        piece = take()
        if piece == "(":
            value = total()[0]
            if take() != ")":
                raise ValueError("unclosed")
            return value, None
        value = _value(piece) if _is_digits(piece) else None
        if value is None:
            raise ValueError("not a number")
        if not piece.isdigit():
            return value, None
        if pieces[at : at + 1] == ["/"] and pieces[at + 1 : at + 2] and pieces[at + 1].isdigit():
            top, bottom = int(piece), int(pieces[at + 1])
            at += 2
            return Fraction(top, bottom), (top, bottom)
        return value, (int(piece), 1)

    def product() -> _Operand:
        left = operand()
        while next_is("*", "x", ":", "/"):
            sign = take()
            right = operand()
            if sign in ("*", "x"):
                value = left[0] * right[0]
            else:
                value = left[0] / right[0]
                steps.update(_division_steps(left[1], right[1]))
            steps.add(value)
            left = (value, None)
        return left

    def total() -> _Operand:
        left = product()
        while next_is("+", "-"):
            sign = take()
            right = product()
            value = left[0] + right[0] if sign == "+" else left[0] - right[0]
            if left[1] is not None and right[1] is not None:
                steps.update(_fraction_steps(left[1], right[1], sign))
            steps.add(value)
            left = (value, None)
        return left

    try:
        answer = total()[0]
    except (ValueError, IndexError, ZeroDivisionError, RecursionError):
        return set()
    if at != len(pieces):
        return set()
    return steps - {answer}


def _fraction_steps(left: tuple[int, int], right: tuple[int, int], sign: str) -> set[Fraction]:
    """What a child writes adding or taking away two fractions: the bottoms'
    product and least common multiple, each top over them, and the new top."""
    (a, b), (c, d) = left, right
    if b == d == 1:
        return set()
    steps: set[Fraction] = set()
    for bottom in {b * d, b * d // gcd(b, d)}:
        top_a, top_c = a * (bottom // b), c * (bottom // d)
        steps.update({Fraction(bottom), Fraction(top_a), Fraction(top_c)})
        steps.add(Fraction(top_a + top_c if sign == "+" else top_a - top_c))
    return steps


def _division_steps(left: tuple[int, int] | None, right: tuple[int, int] | None) -> set[Fraction]:
    """What a child writes dividing by a fraction: its reciprocal, and the
    tops and bottoms multiplied across."""
    if right is None or not right[0]:
        return set()
    (c, d) = right
    steps = {Fraction(d, c)}
    if left is not None:
        (a, b) = left
        steps.update({Fraction(a * d), Fraction(b * c)})
    return steps


def _read_first(said: str) -> str | None:
    """Which number the platform's reader takes from ``said``: the first one
    after its last "es", "da" or "=", otherwise the first one. "digits" when it
    is one written in digits, "word" when a word is taken for a number."""
    kinds = []
    for token in _TOKEN.findall(_plain(said)):
        if token in _MARKERS:
            kinds.append("marker")
        elif _is_digits(token):
            kinds.append("digits")
        elif _is_number_word(token):
            kinds.append("word")
    last = max((at for at, kind in enumerate(kinds) if kind == "marker"), default=-1)
    after = [kind for kind in kinds[last + 1 :] if kind != "marker"]
    numbers = after or [kind for kind in kinds if kind != "marker"]
    return numbers[0] if numbers else None


# What the tutor said last -----------------------------------------------------


def names_other_numbers(said: str, expression: str, language: str) -> bool:
    """Whether ``said``, what the tutor said and showed since the child's
    last turn, names a number that is neither one of ``expression``'s own
    numbers nor the value of one of its steps. Then it asks about another
    computation (a worked example with other numbers, a simpler one, a
    question of its own), and the child's reply answers that: sent to the
    checker, a number would count as a wrong try at the exercise.

    Numbers in digits count, and so do numbers said in words in the
    session's language, as the tutor says them aloud ("cuarenta y cinco",
    "un cuarto"), a fraction by its bottom number. "Un", "una", "uno" and
    "one" alone do not, nor "los dos" or "las dos": in a tutor's line they
    are an article, "cada uno", "uno parecido" or "both" far more often than
    a number."""
    own = _own_numbers(expression)
    plain = _plain(said)
    for written in _NUMBER.findall(plain):
        value = _value(written)
        if value is None or value not in own:
            return True
    words = _WORD.findall(plain)
    return any(Fraction(value) not in own for value in _said_in_words(words, language))


def _counted(words: str, first: int, step: int = 1) -> dict[str, int]:
    return {word: first + step * index for index, word in enumerate(words.split())}


_WORD = re.compile(r"[^\W\d_]+")
# Numbers said in words, in each language: the words for 0 to 9, the other
# numbers said in one word below 30 (20 in English), the tens, the hundreds
# (Spanish says each in one word, English says "hundred" after the number),
# and "thousand".
_UNITS = {
    "es": {
        **_counted("cero uno dos tres cuatro cinco seis siete ocho nueve", 0),
        "un": 1,
        "una": 1,
    },
    "en": _counted("zero one two three four five six seven eight nine", 0),
}
_TEENS = {
    "es": {
        **_counted(
            "diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve "
            "veinte veintiuno veintidos veintitres veinticuatro veinticinco veintiseis "
            "veintisiete veintiocho veintinueve",
            10,
        ),
        "veintiun": 21,
        "veintiuna": 21,
    },
    "en": _counted(
        "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen", 10
    ),
}
_TENS = {
    "es": _counted("treinta cuarenta cincuenta sesenta setenta ochenta noventa", 30, 10),
    "en": _counted("twenty thirty forty fifty sixty seventy eighty ninety", 20, 10),
}
_HUNDREDS = {
    "cien": 100,
    "ciento": 100,
    **{
        f"{stem}{ending}": value
        for stem, value in _counted(
            "doscient trescient cuatrocient quinient seiscient setecient ochocient novecient",
            200,
            100,
        ).items()
        for ending in ("os", "as")
    },
}
_THOUSAND = {"es": "mil", "en": "thousand"}
# The bottom number a fraction's name says: "cuartos" 4, "a third" 3.
_PART_WORDS = {
    "es": {
        **dict.fromkeys(("medio", "media", "mitad"), 2),
        **dict.fromkeys(("tercio", "tercera"), 3),
        **dict.fromkeys(("cuarto", "cuarta"), 4),
        **dict.fromkeys(("quinto", "quinta"), 5),
        **dict.fromkeys(("sexto", "sexta"), 6),
        **dict.fromkeys(("septimo", "septima"), 7),
        **dict.fromkeys(("octavo", "octava"), 8),
        **dict.fromkeys(("noveno", "novena"), 9),
        **dict.fromkeys(("decimo", "decima"), 10),
        "centesimo": 100,
    },
    "en": {
        **dict.fromkeys(("half", "halve"), 2),
        "third": 3,
        **dict.fromkeys(("quarter", "fourth"), 4),
        **_counted("fifth sixth seventh eighth ninth tenth", 5),
    },
}
_NOT_ALONE = {"es": frozenset({"un", "una", "uno"}), "en": frozenset({"one"})}
_BOTH = frozenset({"los", "las"})


def _said_in_words(words: list[str], language: str) -> Iterator[int]:
    """The numbers said in ``words``, plain and one word each, in ``language``."""
    at = 0
    while at < len(words):
        found = _number_at(words, at, language)
        if found is None:
            part = _part(words[at], language)
            if part is not None:
                yield part
            at += 1
            continue
        value, used = found
        alone = used == 1 and words[at] in _NOT_ALONE.get(language, ())
        both = used == 1 and words[at] == "dos" and at > 0 and words[at - 1] in _BOTH
        if not alone and not both:
            yield value
        at += used


def _number_at(words: list[str], at: int, language: str) -> tuple[int, int] | None:
    """The whole number said from ``words[at]``, and how many words it took."""
    found = _below_a_thousand(words, at, language)
    taken = found[1] if found is not None else 0
    if words[at + taken : at + taken + 1] != [_THOUSAND.get(language)]:
        return found
    # "dos mil quinientos", "mil", "three thousand".
    rest = _below_a_thousand(words, at + taken + 1, language)
    value = (found[0] if found is not None else 1) * 1000 + (rest[0] if rest else 0)
    return value, taken + 1 + (rest[1] if rest else 0)


def _below_a_thousand(words: list[str], at: int, language: str) -> tuple[int, int] | None:
    if at >= len(words):
        return None
    if language == "es" and words[at] in _HUNDREDS:
        rest = _below_a_hundred(words, at + 1, language)
        return _HUNDREDS[words[at]] + (rest[0] if rest else 0), 1 + (rest[1] if rest else 0)
    found = _below_a_hundred(words, at, language)
    taken = found[1] if found is not None else 0
    if language != "en" or words[at + taken : at + taken + 1] != ["hundred"]:
        return found
    # "two hundred and five", "a hundred" (the article is no number).
    hundreds = (found[0] if found is not None else 1) * 100
    after = at + taken + 1
    rest_at = after + 1 if words[after : after + 1] == ["and"] else after
    rest = _below_a_hundred(words, rest_at, language)
    if rest is None:
        return hundreds, after - at
    return hundreds + rest[0], rest_at + rest[1] - at


def _below_a_hundred(words: list[str], at: int, language: str) -> tuple[int, int] | None:
    if at >= len(words):
        return None
    word, units = words[at], _UNITS.get(language, {})
    tens = _TENS.get(language, {})
    if word in tens:
        # "cuarenta y cinco"; "forty five", or "forty-five" split at its hyphen.
        unit = at + 2 if language == "es" else at + 1
        joined = language != "es" or words[at + 1 : at + 2] == ["y"]
        if joined and unit < len(words) and units.get(words[unit], 0) > 0:
            return tens[word] + units[words[unit]], unit + 1 - at
        return tens[word], 1
    for table in (_TEENS.get(language, {}), units):
        if word in table:
            return table[word], 1
    return None


def _part(word: str, language: str) -> int | None:
    """The bottom number of a fraction named by ``word``: "cuartos" 4,
    "mitades" 2, "doceavos" 12."""
    parts = _PART_WORDS.get(language, {})
    for singular in (word, word.removesuffix("s"), word.removesuffix("es")):
        if singular in parts:
            return parts[singular]
    stem = word.removesuffix("s").removesuffix("avo")
    if language != "es" or stem == word.removesuffix("s"):
        return None
    value = _TEENS["es"].get(stem) or _TEENS["es"].get(f"{stem}e")
    return value if value is not None and value > 10 else None
