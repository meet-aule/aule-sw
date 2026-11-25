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


def digest(value):
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
