"""The examples judge, offline: what it is sent, and how its answer is read."""

import json
from types import SimpleNamespace

import httpx2 as httpx
import meaning
import pytest
import report
from anthropic import AsyncAnthropic
from budget import Budget, MeteredTransport
from test_report import calibrated, row, turn, write

TURNS = [
    dict(
        turn=1,
        student="Estoy haciendo 25 + 3 * 2. Me salió 56. ¿Está bien?",
        tutor="A ver.\nGracias por contarme cómo lo pensaste.",
    ),
    dict(
        turn=2,
        student="No entiendo. Explícamelo de otra manera, con algo más fácil.",
        tutor="Imagina que tienes veinticinco soles en el bolsillo, y luego compras tres "
        "caramelos que cuestan dos soles cada uno. ¿Cuánto cuestan los caramelos?",
    ),
]
CANDIES = dict(
    turn=2,
    quote="tienes veinticinco soles en el bolsillo, y luego compras tres caramelos",
    stands_for="25 + 3 × 2",
    story_expression="3 × 2",
    whole_story="25 - 3 × 2",
    roles="25 soles held; 3 candies bought at 2 soles each",
    verdict="changes",
    reason="Buying takes money away while the exercise adds.",
)


def answer(examples, stop="end_turn", text=None):
    body = json.dumps({"examples": examples}) if text is None else text
    return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="text", text=body)])


def test_a_well_formed_answer_quoted_from_its_turns_is_read():
    judged = meaning.parse(answer([CANDIES, dict(CANDIES, verdict="unclear")]), TURNS)

    assert judged["status"] == "ok" and judged["changed"] is True and judged["unclear"] == 1
    assert judged["examples"][0]["stands_for"] == "25 + 3 × 2"


def test_no_example_is_an_answer_too_and_changes_nothing():
    judged = meaning.parse(answer([]), TURNS)
    assert (judged["status"], judged["examples"], judged["changed"]) == ("ok", [], False)


def test_a_quote_is_found_whatever_its_case_spacing_and_quotation_marks():
    quote = "«TIENES veinticinco   soles en el bolsillo,»"
    assert meaning.parse(answer([dict(CANDIES, quote=quote)]), TURNS)["status"] == "ok"


@pytest.mark.parametrize(
    "item",
    [
        {key: value for key, value in CANDIES.items() if key != "roles"},
        dict(CANDIES, extra="no"),
        dict(CANDIES, turn="2"),
        dict(CANDIES, turn=True),
        dict(CANDIES, reason=None),
        dict(CANDIES, verdict="wrong"),
        dict(CANDIES, turn=0),
        dict(CANDIES, turn=3),
    ],
)
def test_an_item_out_of_its_schema_makes_the_answer_invalid(item):
    assert meaning.parse(answer([item]), TURNS)["status"] == "invalid"


@pytest.mark.parametrize(
    ("response", "status"),
    [
        (answer([], text="not json"), "invalid"),
        (answer([], text='{"examples": [], "more": 1}'), "invalid"),
        (answer([], text='["examples"]'), "invalid"),
        (SimpleNamespace(stop_reason="end_turn", content=[]), "invalid"),
        (answer([CANDIES], stop="max_tokens"), "truncated"),
        (answer([CANDIES], stop="refusal"), "refused"),
        (answer([CANDIES], stop="pause_turn"), "invalid"),
        # Words the tutor did not say in that turn, or said in another one.
        (answer([dict(CANDIES, quote="tienes 25 figuritas")]), "ungrounded"),
        (answer([dict(CANDIES, turn=1)]), "ungrounded"),
        (answer([dict(CANDIES, quote=" «» ")]), "ungrounded"),
    ],
)
def test_an_answer_that_cannot_be_trusted_is_a_judge_failure(response, status):
    judged = meaning.parse(response, TURNS)
    assert (judged["status"], judged["examples"], judged["changed"]) == (status, [], None)


def test_the_judge_reads_only_what_the_student_and_the_tutor_said():
    saved = [
        dict(
            student="hola",
            assistant=["A ver.", "", "¿Qué harías primero?"],
            tools=[{"tool": "check_answer", "verdict": "incorrect"}],
            function_events=[{"type": "function_call"}],
            gate_events=[{"gate": "moderation_input"}],
            check={"kind": "answer"},
        )
    ]
    assert meaning.visible(saved) == [
        dict(turn=1, student="hola", tutor="A ver.\n¿Qué harías primero?")
    ]


async def test_one_metered_haiku_call_with_its_json_enforced_and_no_thinking(tmp_path):
    budget = Budget(tmp_path / "budget.jsonl", 20)
    transport = MeteredTransport(budget, "math-071:replay:0:examples")
    sent = []

    async def handler(request):
        sent.append(json.loads(await request.aread()))
        return httpx.Response(
            200,
            json=dict(
                id="msg_1",
                type="message",
                role="assistant",
                model=meaning.MODEL,
                content=[{"type": "text", "text": json.dumps({"examples": [CANDIES]})}],
                stop_reason="end_turn",
                stop_sequence=None,
                usage={"input_tokens": 1200, "output_tokens": 300},
            ),
        )

    await transport.inner.aclose()
    transport.inner = httpx.MockTransport(handler)
    api = AsyncAnthropic(
        api_key="test", max_retries=0, http_client=httpx.AsyncClient(transport=transport)
    )
    async with api:
        judged = await meaning.judge(api, "25 + 3 * 2", "31", TURNS)

    assert judged["status"] == "ok" and judged["changed"] is True
    (body,) = sent
    assert body["model"] == "claude-haiku-5-5" and body["max_tokens"] <= 2048
    assert body["thinking"] == {"type": "disabled"}
    assert body["output_config"]["format"] == {"type": "json_schema", "schema": meaning.SCHEMA}
    assert body["system"] == meaning.PROMPT
    assert not {"temperature", "top_p", "top_k"} & set(body)
    (message,) = body["messages"]
    assert json.loads(message["content"]) == dict(
        exercise="25 + 3 * 2", exact_answer="31", turns=TURNS
    )
    # One reservation, settled from the usage returned.
    assert budget.summary()["calls"] == 1 and budget.summary()["unreconciled_calls"] == 0
    assert budget.committed == pytest.approx((1200 * 0.1 + 300 * 0.5) / 1_000_000)
    budget.close()


def test_the_schema_puts_the_mapping_before_the_verdict():
    item = meaning.SCHEMA["properties"]["examples"]["items"]
    order = list(item["properties"])
    assert order.index("story_expression") < order.index("whole_story") < order.index("verdict")
    assert order.index("verdict") < order.index("reason")
    assert item["additionalProperties"] is False and meaning.SCHEMA["additionalProperties"] is False


def test_the_judge_is_told_to_read_the_whole_story_its_setup_included():
    # The candy story asks only what the candies cost (3 × 2), but it starts
    # with 25 soles in the pocket: carried out whole it is 25 - 3 × 2.
    assert "Judge the whole story, its setup included" in meaning.PROMPT
    assert "Adding up what was bought,\neaten or given keeps it." in meaning.PROMPT


def judged(*examples, status="ok"):
    return dict(
        model=meaning.MODEL,
        status=status,
        examples=list(examples),
        changed=any(x["verdict"] == "changes" for x in examples) if status == "ok" else None,
        unclear=sum(x["verdict"] == "unclear" for x in examples),
    )


def test_the_report_fails_a_session_whose_example_changes_the_meaning_and_lists_it(tmp_path):
    keeps = dict(CANDIES, verdict="keeps", quote="tres caramelos")
    rows = [
        row("changed", [turn()], examples=judged(CANDIES, keeps)),
        row("kept", [turn()], examples=judged(keeps)),
        row("unclear", [turn()], examples=judged(dict(CANDIES, verdict="unclear"))),
        row("failed", [turn()], examples=judged(status="ungrounded")),
        row("not-measured", [turn()], examples=None),
    ]
    write(tmp_path, *rows)
    calibrated(tmp_path)

    built = report.build(tmp_path)
    report.render(built, tmp_path)

    group = built["groups"]["regression/replay"]
    assert (group["sessions"], group["legacy_passes"], group["checks_complete"]) == (5, 5, 5)
    # Unclear is for review, not a failure; a judge failure and no judge cannot pass.
    assert group["passes"] == 2
    assert {failure["id"] for failure in built["failures"]} == {
        "changed",
        "failed",
        "not-measured",
    }
    assert (group["examples_measured"], group["examples_judge_failures"]) == (4, 1)
    assert (group["sessions_with_changed_examples"], group["changed_examples"]) == (1, 1)
    assert group["unclear_examples"] == 1
    assert [x["id"] for x in built["changed_examples"]] == ["changed"]
    assert [x["id"] for x in built["unclear_examples"]] == ["unclear"]
    markdown = (tmp_path / "report.md").read_text()
    assert "Examples that change the meaning" in markdown and CANDIES["quote"] in markdown
    assert "For review (unclear)" in markdown
