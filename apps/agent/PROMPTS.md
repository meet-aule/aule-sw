# Model instructions

Author instructions in English. Choose the output language separately from the
language of the instructions. Keep student/family data, quoted exercises and
fixed spoken replies in their original language. Translating those would change
what the student said or what the engine intends to say.

## Inventory

These are six system-prompt functions, not six blocks concatenated into one call.
Model names below are source defaults; environment overrides can change routing.

| Function | Source | Default model | Output contract |
|---|---|---|---|
| Spoken tutor | [prompts.py](src/aule_agent/prompts.py), assembled by [tutor.py](src/aule_agent/tutor.py) | Sonnet 5.5 | Final language rule: Peruvian Spanish (`es`) or English (`en`), including screen text; language-practice examples may use the language being learned |
| Session plan | [supervisor::plan](../platform/src/supervisor.rs) | Sonnet 5.5 | Structured JSON; internal prose in English |
| Live guidance | [supervisor::watch](../platform/src/supervisor.rs) | Haiku 5.5 | Structured JSON; internal prose in English |
| Session review | [supervisor::review](../platform/src/supervisor.rs) | Sonnet 5.5 | Structured JSON; parent summary in the profile language, memories in the language spoken, internal next step in English |
| Tutor reply second reading | [opinion.QUESTION](src/aule_agent/opinion.py) | Haiku 5.5 | Exactly `SAFE` or `UNSAFE` |
| Student input second reading | [opinion.HEARD_QUESTION](src/aule_agent/opinion.py) | Haiku 5.5 | Exactly `ORDINARY` or `CONCERN` |

There is also an English structured question for [physical safety](src/aule_agent/physical_safety.py)
sent to TypeSafe Jev, and two English experiment prompts: the
[pedagogy judge](evals/pedagogy/evaluate.py) and [candidate proposer](evals/pedagogy/autonomous.py).
OpenAI moderation uses a classifier endpoint, without an authored system prompt.
Do not translate classifier labels, JSON keys, enums or tool identifiers.

## Tutor composition

One canonical English policy is shared by both languages. The applicable blocks,
in order, are:

1. Teaching, speech, camera and instruction/data boundaries.
2. Screen rules only with `show`; break rules only with managed breaks; checking
   rules only with `pose_exercise` and `check_answer`.
3. Student context and the initial or late supervisor plan.
4. Tutor name and family tone preferences, quoted as data; preset tone in English.
5. The latest supervisor guidance, replacing the previous guidance.
6. Current [session engine rules](../../engine/crates/aule-core/src/conversacion.rs),
   when the engine permits conversation. Those restrictions govern the current
   stage: for example, screening permits vocabulary clarification but no solving
   hints, and the engine owns its exercise and grading.
7. One final output-language rule, on creation and after every update.

The engine's [platform adapter](../platform/src/engine/mod.rs) separates its
state/statement as JSON data from its English rules. Its fixed spoken lines are
not model instructions and remain localized. Tone preferences do not gain
authority from their position; the policy explicitly keeps them subordinate.
Quoting data helps distinguish it, but is not a guarantee against prompt injection.

## Validation

[test_prompt_delivery.py](tests/test_prompt_delivery.py) runs the real AgentSession,
LiveKit Anthropic plugin and Anthropic SDK with an intercepted HTTP transport.
Sixteen language/screen/checker/break combinations each make five requests:
initial, guidance, late plan, replaced guidance plus engine restrictions, and
cleared engine restrictions. It checks the complete outgoing system text, final
language block, optional tools and preservation/removal of the right rules.

The existing 4,000-character limit still covers the complete static tutor policy;
profile, plan, persona, guidance, engine rules and conversation are additional
dynamic context, not covered by that limit. Provider context limits and actual
token usage are distinct from this local size guard.

Supervisor tests inspect each request's system text, tier and final language
contract; engine tests cover screening, simulation, hints, breaks and closure.
Second-reading tests check the exact prompt and fail-closed label parsing. The
physical-safety question, thresholds and safety gates are unchanged.

Passing delivery tests proves which instructions were sent. Real-model synthetic
evaluations are still needed to measure obedience, language, correct tool use and
mathematics. Neither proves learning gains or correctness for every child.
