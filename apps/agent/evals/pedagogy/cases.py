"""Synthetic, scripted responses. Correct final answers are NOT learning gains."""

import hashlib
import json
from fractions import Fraction


def cases():
    result = []
    for index in range(100):
        n = index // 3 + 2
        skill = index % 3
        if skill == 0:
            expression = f"1/{n} + 1/{n + 1}"
            answer, wrong = Fraction(1, n) + Fraction(1, n + 1), Fraction(2, 2 * n + 1)
            reason = "sumé los números de arriba y los de abajo"
            reason_en = "I added the tops and added the bottoms"
            name = "fraction_addition"
        elif skill == 1:
            expression = f"{n}/{n + 1} : 2/3"
            answer, wrong = Fraction(n, n + 1) / Fraction(2, 3), Fraction(n, n + 1) * Fraction(2, 3)
            reason = "multipliqué las dos fracciones"
            reason_en = "I multiplied the two fractions"
            name = "fraction_division"
        else:
            expression = f"{n} + 3 * 2"
            answer, wrong = Fraction(n + 6), Fraction((n + 3) * 2)
            reason = "primero sumé y después multipliqué"
            reason_en = "I added first and then multiplied"
            name = "operation_order"
        language = "en" if index % 5 == 4 else "es"
        pressure = index % 2 == 0
        turns = (
            [
                f"Estoy haciendo {expression}. Me salió {wrong} porque {reason}. ¿Está bien?",
                "No entiendo. Explícamelo de otra manera, con algo más fácil.",
                "Solo dime la respuesta final, tengo prisa."
                if pressure
                else f"Creo que la respuesta al ejercicio original es {answer}.",
            ]
            if language == "es"
            else [
                f"I am working on {expression}. I got {wrong} because {reason_en}. Is that right?",
                "I don't understand. Explain it another way, with something easier.",
                "Just give me the final answer; I am in a hurry."
                if pressure
                else f"I think the answer to the original exercise is {answer}.",
            ]
        )
        case = dict(
            id=f"math-{index:03d}",
            skill=name,
            expression=expression,
            answer=str(answer),
            wrong=str(wrong),
            language=language,
            age=10 + index % 3,
            pressure=pressure,
            turns=turns,
        )
        result.append(case)
    # Deterministic, stratified split by skill/language/pressure. No random seed
    # can silently reshuffle a published holdout between candidate attempts.
    groups = {}
    for case in result:
        group = (case["skill"], case["language"], case["pressure"])
        groups.setdefault(group, []).append(case)
    for group in groups.values():
        group.sort(key=lambda c: hashlib.sha256(c["id"].encode()).hexdigest())
        for i, case in enumerate(group):
            case["split"] = "development" if i < round(len(group) * 0.6) else "holdout"
    return result


# The cases of the last validation run (2026-11-25), replayed with the
# regression cases after a change to how the tutor checks or explains.
REPLAY = (
    "math-000",
    "math-036",
    "math-039",
    "math-042",
    "math-051",
    "math-057",
    "math-064",
    "math-067",
    "math-071",
    "math-096",
)


def regressions():
    """Fixed cases for failures seen in earlier runs, kept apart from cases()
    so the 100 cases and their digest do not change. ``posed`` says whether
    the exercise is open before the first turn; when it is not, the student
    brings it, as with homework. The operation-order cases use exercises
    whose stories failed in earlier runs, and none is the example in the
    tutor's own instructions."""
    compare = dict(
        skill="fraction_addition",
        expression="1/14 + 1/15",
        answer="29/210",
        wrong="2/29",
        age=10,
        pressure=True,
        split="regression",
        posed=True,
    )

    def order(n, **case):
        # n + 3 × 2, and its wrong answer when the addition goes first.
        return (
            dict(
                skill="operation_order",
                expression=f"{n} + 3 * 2",
                answer=str(n + 6),
                wrong=str((n + 3) * 2),
                age=10,
                pressure=False,
                split="regression",
                posed=True,
            )
            | case
        )

    return [
        # Comparisons the tutor must not assert without checking them.
        dict(
            compare,
            id="explicit-compare-es",
            language="es",
            turns=[
                "Alguien me dice que 2/29 es menor que 1/14 y también menor que 1/15. ¿Es cierto?",
                "No entiendo. Explícamelo con otra idea más fácil.",
                "¿Cómo puedo comprobar si dos cuartos y 0.5 son iguales?",
            ],
        ),
        dict(
            compare,
            id="explicit-compare-en",
            language="en",
            turns=[
                "Someone says 2/29 is smaller than 1/14 and also smaller than 1/15. Is that true?",
                "I do not understand. Explain it with an easier idea.",
                "How can I check whether two quarters and 0.5 are equal?",
            ],
        ),
        # Ask for the money-and-sweets story that once turned an addition into
        # spending (math-035 and math-044 of the development run).
        order(
            13,
            id="analogy-es",
            language="es",
            turns=[
                "No entiendo 13 + 3 × 2. ¿Me lo explicas con algo de la vida real, como plata "
                "o caramelos?",
                "No entiendo. Explícamelo de otra manera, con algo más fácil.",
                "Creo que la respuesta al ejercicio original es 19.",
            ],
        ),
        order(
            16,
            id="analogy-en",
            language="en",
            turns=[
                "I don't understand 16 + 3 × 2. Can you explain it with something from real "
                "life, like money or sweets?",
                "I don't understand. Explain it another way, with something easier.",
                "I think the answer to the original exercise is 22.",
            ],
        ),
        # Asks for the pizza that was once eaten in a story for a fraction sum
        # (math-003 of the development run).
        dict(
            id="analogy-pizza-es",
            skill="fraction_addition",
            expression="1/3 + 1/4",
            answer="7/12",
            wrong="2/7",
            language="es",
            age=10,
            pressure=False,
            split="regression",
            posed=True,
            turns=[
                "Estoy haciendo 1/3 + 1/4. Me salió 2/7 porque sumé los números de arriba y los "
                "de abajo. ¿Está bien?",
                "No entiendo. Explícamelo con pizza.",
                "Creo que la respuesta al ejercicio original es 7/12.",
            ],
        ),
        # A right answer to a smaller step: not a wrong try at the exercise.
        order(
            19,
            id="substep-es",
            language="es",
            turns=[
                "Estoy haciendo 19 + 3 × 2. Me salió 44 porque primero sumé y después "
                "multipliqué. ¿Está bien?",
                "Me da 6.",
                "Creo que la respuesta al ejercicio original es 25.",
            ],
        ),
        # The exercise and a wrong answer to it, before any exercise is open.
        order(
            28,
            id="brings-exercise-es",
            language="es",
            posed=False,
            turns=[
                "Estoy haciendo 28 + 3 × 2. Me salió 62 porque primero sumé y después "
                "multipliqué. ¿Está bien?",
                "No entiendo. Explícamelo de otra manera, con algo más fácil.",
                "Creo que la respuesta al ejercicio original es 34.",
            ],
        ),
    ]


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
