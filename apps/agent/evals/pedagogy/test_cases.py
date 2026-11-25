import re

from cases import REPLAY, cases, digest, regressions

from aule_agent.prompts import INSTRUCTIONS

# The 100 fixed cases as published: adding the replay must not move them.
DATASET_SHA256 = "ba0d5c718c390a806f3ca002456f665b3b956edc875966d67cffaf5cbf7d5bbf"


def test_the_hundred_cases_are_unchanged():
    assert digest(cases()) == DATASET_SHA256


def test_the_regression_cases_are_apart_from_the_hundred_and_the_replay_names_real_ones():
    ids = {case["id"] for case in cases()}
    extra = [case["id"] for case in regressions()]
    assert len(extra) == len(set(extra)) and not ids & set(extra)
    assert len(REPLAY) == len(set(REPLAY)) == 10 and set(REPLAY) <= ids
    for case in regressions():
        assert case["split"] == "regression" and isinstance(case["posed"], bool)
        assert len(case["turns"]) == 3 and case["answer"] != case["wrong"]
        assert {"skill", "expression", "language", "age", "pressure"} <= set(case)


def test_the_regressions_ask_for_the_story_that_changed_an_operation_and_bring_an_exercise():
    by_id = {case["id"]: case for case in regressions()}
    assert "plata o caramelos" in by_id["analogy-es"]["turns"][0]
    assert "money or sweets" in by_id["analogy-en"]["turns"][0]
    # The story that once ate the pizza of a fraction sum.
    assert by_id["analogy-pizza-es"]["skill"] == "fraction_addition"
    assert "pizza" in by_id["analogy-pizza-es"]["turns"][1]
    # A right answer to a smaller step (3 × 2) in the second turn.
    assert by_id["substep-es"]["turns"][1] == "Me da 6."
    # Homework brought to the tutor: nothing is open before its first turn.
    assert by_id["brings-exercise-es"]["posed"] is False
    assert by_id["brings-exercise-es"]["turns"][0].startswith("Estoy haciendo 28 + 3 × 2.")
    assert all(case["posed"] for key, case in by_id.items() if key != "brings-exercise-es")
    # Every operation-order case is a different exercise.
    orders = [case["expression"] for case in by_id.values() if case["skill"] == "operation_order"]
    assert len(orders) == len(set(orders)) == 4


def test_no_case_is_the_exercise_the_tutors_instructions_give_as_an_example():
    # A tutor that repeats its instructions' example must not pass a case for it.
    def plain(expression):
        return expression.replace("×", "*").replace(" ", "")

    # One English policy for both languages; its example is "(18 + 4 × 5: ...".
    examples = {plain(found) for found in re.findall(r"\(([0-9][0-9 +×*:/]*[0-9]):", INSTRUCTIONS)}
    assert examples
    assert not examples & {plain(case["expression"]) for case in cases() + regressions()}
