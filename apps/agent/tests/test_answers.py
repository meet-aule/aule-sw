"""What of a child's turn goes to the checker. Each case is one the platform's
reader (apps/platform/src/exercise.rs) reads right as sent, or one that stays
with the model: it would be misread, or it is not an answer or a request for
help with the exercise."""

import pytest

from aule_agent.answers import HELP_SENT, MAX_SAID_CHARS, Reading, names_other_numbers, to_check

ORDER = "25 + 3 * 2"
FRACTIONS = "1/2 + 1/3"
DIVISION = "23/24 : 2/3"
COMPARED = "1/14 + 1/15"


@pytest.mark.parametrize(
    ("words", "expression", "language", "said"),
    [
        # The three turns of the scripted students, Spanish and English.
        (
            "Estoy haciendo 25 + 3 * 2. Me salió 56 porque primero sumé y después multipliqué. "
            "¿Está bien?",
            ORDER,
            "es",
            "Estoy haciendo . Me salió 56 porque primero sumé y después multipliqué. ¿Está bien?",
        ),
        (
            "Estoy haciendo 23/24 : 2/3. Me salió 23/36 porque multipliqué las dos fracciones. "
            "¿Está bien?",
            DIVISION,
            "es",
            "Estoy haciendo . Me salió 23/36 porque multipliqué las dos fracciones. ¿Está bien?",
        ),
        (
            "I am working on 1/2 + 1/3. I got 2/5 because I added the tops and added the "
            "bottoms. Is that right?",
            FRACTIONS,
            "en",
            "I am working on . I got 2/5 because I added the tops and added the bottoms. "
            "Is that right?",
        ),
        (
            "Creo que la respuesta al ejercicio original es 31.",
            ORDER,
            "es",
            "Creo que la respuesta al ejercicio original es 31.",
        ),
        (
            "I think the answer to the original exercise is 23/16.",
            DIVISION,
            "en",
            "I think the answer to the original exercise is 23/16.",
        ),
        ("Me salió 56, ¿está bien?", ORDER, "es", "Me salió 56, ¿está bien?"),
        ("I got 56, is that right?", ORDER, "en", "I got 56, is that right?"),
        ("Me salió 31 está bien?", ORDER, "es", "Me salió 31 está bien?"),
        ("Es 31, ¿no?", ORDER, "es", "Es 31, ¿no?"),
        ("0,75", "0.5 + 0.25", "es", "0,75"),
        # The answer, however it is written, is never taken for one of its steps.
        ("5/6", FRACTIONS, "es", "5/6"),
        ("69/48", DIVISION, "es", "69/48"),
        ("Me da 23/16", DIVISION, "es", "Me da 23/16"),
    ],
)
def test_an_answer_in_digits_goes_as_written_without_the_exercise(
    words, expression, language, said
):
    assert to_check(words, expression, language).said == said
    assert to_check(words, expression, language).kind == "answer"


@pytest.mark.parametrize(
    ("words", "language"),
    [
        ("No entiendo. Explícamelo de otra manera, con algo más fácil.", "es"),
        ("No entiendo. Explícamelo con otra idea más fácil.", "es"),
        ("I don't understand. Explain it another way, with something easier.", "en"),
        ("I do not understand. Explain it with an easier idea.", "en"),
        ("No entiendo 25 + 3 × 2. ¿Me lo explicas con algo de la vida real?", "es"),
        # Articles are read as 1 by the platform; sent as "no sé" they are not.
        ("No entiendo, explícamelo con un dibujo", "es"),
        ("No entiendo. Explícamelo con pizza.", "es"),
        ("dame una pista", "es"),
        ("Ni idea", "es"),
        ("NO SÉ", "es"),
        ("no se", "es"),
        ("no lo sé", "es"),
        ("Ya no sé", "es"),
        ("No sé cómo hacerlo", "es"),
        ("no sé qué hacer", "es"),
        ("No le entiendo", "es"),
        ("No entiendo este ejercicio", "es"),
        ("No sé, explícame", "es"),
        ("I dont know", "en"),
        ("I don't get it", "en"),
        ("I don't know how to do this", "en"),
        ("I can't do it", "en"),
        ("Can I have a hint?", "en"),
    ],
)
def test_a_request_for_help_goes_as_the_fixed_phrase(words, language):
    assert to_check(words, ORDER, language) == Reading(
        HELP_SENT[language], "help", "25 + 3 × 2" in words
    )


@pytest.mark.parametrize(
    ("words", "expression", "language"),
    [
        # The regression cases that ask for a story: the objects of the story
        # asked for go with the request.
        (
            "No entiendo 13 + 3 × 2. ¿Me lo explicas con algo de la vida real, como plata o "
            "caramelos?",
            "13 + 3 * 2",
            "es",
        ),
        (
            "I don't understand 16 + 3 × 2. Can you explain it with something from real life, "
            "like money or sweets?",
            "16 + 3 * 2",
            "en",
        ),
    ],
)
def test_a_request_for_help_with_the_exercise_said_again_goes_as_the_fixed_phrase(
    words, expression, language
):
    assert to_check(words, expression, language) == Reading(HELP_SENT[language], "help", True)


@pytest.mark.parametrize(
    ("words", "language"),
    [
        # A help phrase is not enough: "no se" before a verb, thanks, a wish to
        # do it alone, a question of why, a tired child, a screen.
        ("No se ve bien la pantalla", "es"),
        ("No se escucha nada", "es"),
        ("Ah, ya entendí: no se suman los de abajo", "es"),
        ("¿Por qué no se puede sumar arriba y abajo?", "es"),
        ("Gracias, eso me ayuda mucho", "es"),
        ("Lo quiero hacer sin ayuda", "es"),
        ("No puedo más, estoy cansado", "es"),
        ("No puedo ver tu dibujo", "es"),
        ("Thanks for the help!", "en"),
        ("I can't see the screen", "en"),
        # A fright, a hurt, a sibling, a parent: never a "no sé" to the exercise.
        ("Ayúdame, tengo miedo", "es"),
        ("No puedo respirar bien", "es"),
        ("ayuda, mi hermano me está pegando", "es"),
        ("no puedo más, estoy muy cansado", "es"),
        ("No sé, mi mamá dice que soy tonto", "es"),
        ("no entiendo por qué mis papás pelean", "es"),
        ("Help, I'm scared", "en"),
        ("help me, my tummy hurts", "en"),
        ("I cannot breathe", "en"),
        ("I don't understand why my parents are shouting", "en"),
        # The device, or the tutor's voice.
        ("no se escucha nada", "es"),
        ("no me sale la voz", "es"),
        ("no te entiendo, hablas muy rápido", "es"),
        ("I can't hear you", "en"),
        ("I don't understand you", "en"),
        # Help, or "I can't", without saying with what: the model reads it.
        ("ayúdame porfa", "es"),
        ("ayuda", "es"),
        ("help", "en"),
        ("no puedo, no hay nadie", "es"),
        ("No puedo hacerlo más", "es"),
        ("I can't do it anymore", "en"),
        ("I can't wait to try the next one", "en"),
        # Not asking for a hint.
        ("No necesito una pista", "es"),
        ("I don't need a hint", "en"),
    ],
)
def test_a_help_phrase_said_of_something_else_stays_with_the_model(words, language):
    assert to_check(words, ORDER, language) == Reading(None, "left", False)


@pytest.mark.parametrize(
    ("words", "expression"),
    [
        # A smaller step the tutor asked, answered right: 3 × 2 of 25 + 3 × 2;
        # the common bottom, a top over it, a fraction over it or the new top of
        # 1/2 + 1/3; the reciprocal, and the tops and bottoms multiplied across,
        # of 23/24 : 2/3. Sent, each would count as a wrong try at the exercise.
        ("6", ORDER),
        ("Me da 6.", ORDER),
        ("6", FRACTIONS),
        ("3/6", FRACTIONS),
        ("me sale 5", FRACTIONS),
        ("3/2", DIVISION),
        ("69", DIVISION),
        ("48", DIVISION),
        ("5", "(2 + 3) × 4"),
        ("12", "2 + 3 × 4 - 5"),
    ],
)
def test_a_value_of_one_of_the_exercises_steps_stays_with_the_model(words, expression):
    assert to_check(words, expression, "es") == Reading(None, "left", False)


@pytest.mark.parametrize(
    ("words", "expression"),
    [
        # The explicit comparison questions: doubts, not answers.
        (
            "Alguien me dice que 2/29 es menor que 1/14 y también menor que 1/15. ¿Es cierto?",
            COMPARED,
        ),
        ("¿Cómo puedo comprobar si dos cuartos y 0.5 son iguales?", COMPARED),
        (
            "Someone says 2/29 is smaller than 1/14 and also smaller than 1/15. Is that true?",
            COMPARED,
        ),
        ("How can I check whether two quarters and 0.5 are equal?", COMPARED),
        # Reasoning with the exercise's own numbers.
        ("¿primero multiplico 3 por 2?", ORDER),
        ("multipliqué 3 por 2 y me dio 6", ORDER),
        ("3", ORDER),
        ("Me salió 2/4", FRACTIONS),
        # Numbers said in words: the platform reads "treinta y uno" as 30.
        ("treinta y uno", ORDER),
        ("No sé, ¿cincuenta y seis?", ORDER),
        ("I don't know, thirty one?", ORDER),
        # Neither an answer nor a request for help.
        ("Solo dime la respuesta final, tengo prisa.", ORDER),
        ("Just give me the final answer; I am in a hurry.", ORDER),
        ("tengo hambre", ORDER),
        # A word before the answer that the platform takes for the number.
        ("A mí me salió 31", ORDER),
        ("La respuesta es un 31", ORDER),
        ("I got a 31", ORDER),
        # Two numbers, or a question after the answer.
        ("Me salió 56 o 31", ORDER),
        ("Me salió 31. ¿Está bien? No sé.", ORDER),
        ("Is it 31?", ORDER),
        # What the platform cannot read as the number written.
        ("Me salió -31", ORDER),
        ("menos 31", ORDER),
        ("Me salió 31/0", ORDER),
        ("3.1415926", ORDER),
        ("99999999999999999999", ORDER),
        # The exercise is not plain arithmetic: its answers are read otherwise.
        ("x = 4", "2x + 3 = 11"),
        ("24", "6 por 4 centímetros"),
    ],
)
def test_anything_else_stays_with_the_model(words, expression):
    for language in ("es", "en"):
        reading = to_check(words, expression, language)
        assert reading.said is None and reading.kind == "left", words


@pytest.mark.parametrize(
    "words",
    [
        "25+3*2 = 31",
        "25 + 3 x 2 = 31",
        "25 + 3 X 2 = 31",
        "25 + 3 × 2 = 31",
        "25 + 3·2 = 31",
        "25+ 3 *2= 31",
    ],
)
def test_the_exercise_said_again_is_found_however_it_is_spaced_or_signed(words):
    reading = to_check(words, ORDER, "es")
    assert reading.restated and reading.kind == "answer"
    assert reading.said is not None and reading.said.replace(" ", "") == "=31"


def test_the_signs_of_division_and_fractions_are_found_in_their_other_forms():
    assert to_check("23/24 ÷ 2/3 = 23/16", DIVISION, "es").said == "= 23/16"
    assert to_check("1⁄2 + 1⁄3 = 5/6", FRACTIONS, "es").said == "= 5/6"
    assert to_check("6 × 4 = 24", "6 × 4 = ?", "es").said == "= 24"
    assert to_check("3x4=12", "3 x 4", "es").said == "=12"


def test_a_number_that_only_starts_or_ends_like_the_exercise_is_not_it():
    assert not to_check("125 + 3 * 2 es 131", ORDER, "es").restated
    assert not to_check("25 + 3 * 20 es 85", ORDER, "es").restated
    assert not to_check("1/2 + 1/35 es 37/70", FRACTIONS, "es").restated


def test_an_unknown_is_not_taken_for_a_multiplication_sign():
    assert to_check("2x + 3 = 11", "2x + 3 = 11", "es") == Reading(None, "left", False)
    assert to_check("no sé", "x^2 - 5x + 6", "es") == Reading("no sé", "help", False)


def test_a_long_turn_goes_as_its_last_characters_from_the_start_of_a_word():
    words = "palabra " * 70 + "y al final me salió 31"
    reading = to_check(words, ORDER, "es")

    assert reading.kind == "answer" and reading.said is not None
    assert len(reading.said) <= MAX_SAID_CHARS
    assert reading.said.startswith("palabra ") and reading.said.endswith("me salió 31")
    assert words.endswith(reading.said)


def test_a_long_turn_whose_answer_is_cut_away_is_not_sent():
    words = "me salió 31 " + "y otra cosa " * 60
    assert to_check(words, ORDER, "es") == Reading(None, "left", False)


@pytest.mark.parametrize(
    "words",
    ["", "   ", "?!", "¿?", "...", "ñandú 日本語", "٣١", "３１", "\n\t", "😀 31 😀", "/", "= ="],
)
def test_any_input_is_read_without_raising(words):
    for expression in (ORDER, FRACTIONS, "", "x", "(((", "1/0 + 2"):
        for language in ("es", "en"):
            reading = to_check(words, expression, language)
            assert reading.kind in ("help", "answer", "left")
            assert (reading.said is None) == (reading.kind == "left")


# What the tutor said last: about the exercise, or about other numbers.


@pytest.mark.parametrize(
    ("said", "expression", "language"),
    [
        # A worked example with other numbers, in digits or in words, as the
        # platform asks for after the last hint, and as the analogy rule's own.
        ("Hagamos uno parecido: 4 + 2 × 5. ¿Cuánto es 2 × 5?", ORDER, "es"),
        ("Hagamos uno parecido: cuatro más dos por cinco. ¿Cuánto da?", ORDER, "es"),
        ("Uno parecido: doce más tres por cuatro. ¿Cuánto es?", "18 + 4 × 5", "es"),
        ("Imagina 2 bolsas con 3 manzanas y 1 manzana suelta.", "20 + 3 * 2", "es"),
        ("Let's do a similar one: four plus two times five.", ORDER, "en"),
        # A question of its own, after a pose the platform refused.
        ("¿Cuál es mayor, cero coma cinco o cero coma cuarenta y cinco?", "7 × 8", "es"),
        ("Which is bigger, 0.5 or 0.45?", "7 × 8", "en"),
        # A simpler fraction, named by its bottom number.
        ("Probemos con un cuarto más un cuarto.", FRACTIONS, "es"),
        ("Try a quarter plus a quarter.", FRACTIONS, "en"),
        # Numbers said in more than one word.
        ("Piensa en treinta y siete caramelos.", ORDER, "es"),
        ("Ciento veinte más dos mil quinientos.", ORDER, "es"),
        ("Two hundred and five.", ORDER, "en"),
        # The child's own wrong answer said back: what follows may answer it.
        ("¿Cincuenta y seis? Cuéntame cómo llegaste.", ORDER, "es"),
        # A number the platform could not read.
        ("Mira: 99999999999999999999.", ORDER, "es"),
    ],
)
def test_a_line_that_names_other_numbers_is_about_something_else(said, expression, language):
    assert names_other_numbers(said, expression, language)


@pytest.mark.parametrize(
    ("said", "expression", "language"),
    [
        # The exercise's own numbers, and the values of its steps.
        ("¿Cuánto es tres por dos?", ORDER, "es"),
        ("Veinticinco más seis: ¿cuánto da?", ORDER, "es"),
        ("What is three times two?", ORDER, "en"),
        ("Un medio más un tercio: piensa en sextos.", FRACTIONS, "es"),
        ("¿Cuál es el recíproco de dos tercios?", DIVISION, "es"),
        ("Cero coma cinco más cero coma veinticinco.", "0,5 + 0,25", "es"),
        ("Muy bien. ¿Cuánto es tres cuartos más un octavo?", "3/4 + 1/8", "es"),
        ("Catorce quinceavos y quince catorceavos.", COMPARED, "es"),
        # An article, a pronoun or "both", not a number.
        ("Hagamos uno parecido, cada uno con su paso.", ORDER, "es"),
        ("Bien. Ahora suma los dos números, o las dos partes.", ORDER, "es"),
        ("Which one do you do first? Once you know, tell me.", ORDER, "en"),
        # No number at all.
        ("¿Qué operación harías primero?", ORDER, "es"),
        ("", ORDER, "es"),
    ],
)
def test_a_line_with_only_the_exercises_numbers_is_about_it(said, expression, language):
    assert not names_other_numbers(said, expression, language)


def test_only_the_sessions_language_is_read_in_words():
    # "once" is eleven in Spanish, "ten" says "have" in Spanish.
    assert names_other_numbers("Once más.", ORDER, "es")
    assert not names_other_numbers("Once more.", ORDER, "en")
    assert not names_other_numbers("Ten cuidado.", ORDER, "es")
    assert names_other_numbers("Ten more.", ORDER, "en")


@pytest.mark.parametrize(
    "said",
    ["", "?!", "y y y", "mil mil", "hundred and", "treinta y", "ciento", "veinteavos", "٣١ ３１"],
)
def test_any_line_is_read_without_raising(said):
    for expression in (ORDER, FRACTIONS, "", "x", "(((", "1/0 + 2"):
        for language in ("es", "en", "fr"):
            assert names_other_numbers(said, expression, language) in (True, False)
