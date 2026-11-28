from aule_agent.script import MAX_LINE_CHARS, MAX_LINES, Line, Reply, lines_from, reply_from

DRAWING = {"kind": "dot_array", "rows": 2, "columns": 3}


def test_lines_are_read_in_order_and_a_broken_one_is_left_out():
    lines = lines_from(
        [
            {"say": " Hola. ", "show": None, "echoes": False},
            {"say": ""},
            "not a line",
            {"say": 7},
            {"say": "x" * (MAX_LINE_CHARS + 1)},
            {"say": "Mira.", "show": DRAWING, "echoes": False},
        ]
    )

    assert lines == (Line("Hola."), Line("Mira.", show=DRAWING))
    assert lines_from("nope") == () and lines_from(None) == ()


def test_a_drawing_the_screen_cannot_draw_is_dropped_and_its_line_kept():
    line = {"say": "Mira.", "show": {"kind": "hologram"}, "echoes": False}

    assert lines_from([line]) == (Line("Mira."),)


def test_no_more_lines_than_a_turn_can_hold():
    assert len(lines_from([{"say": "a"}] * (MAX_LINES + 5))) == MAX_LINES


def test_a_reply_is_lines_rules_for_talking_or_both_and_nothing_is_none():
    said = {"lines": [{"say": "Bien.", "echoes": False}]}

    assert reply_from(said) == Reply(lines=(Line("Bien."),))
    assert reply_from({"lines": [], "converse": " No hints. "}) == Reply(converse="No hints.")
    assert reply_from({"lines": [], "converse": None}) is None
    assert reply_from({}) is None and reply_from(None) is None and reply_from([]) is None


def test_a_line_may_repeat_the_student_unless_the_engine_says_it_does_not():
    lines = lines_from(
        [
            {"say": "Dijiste tres cuartos.", "echoes": True},
            {"say": "Pregunta 2 de 5.", "echoes": False},
            # Said by a platform that does not tell: taken as one that may.
            {"say": "¿Y cómo lo pensaste?"},
            {"say": "Sigue.", "echoes": "no"},
        ]
    )

    assert [line.echoes for line in lines] == [True, False, True, True]


def test_the_engine_can_close_the_session_with_or_without_last_words():
    goodbye = {"lines": [{"say": "Hasta la próxima.", "echoes": False}], "closed": True}

    assert reply_from(goodbye) == Reply(lines=(Line("Hasta la próxima."),), closed=True)
    assert reply_from({"lines": [], "closed": True}) == Reply(closed=True)
    assert reply_from({"lines": [], "closed": "yes"}) is None


def test_what_the_engine_waits_for_comes_with_what_it_says_and_only_known_values_count():
    line = [{"say": "Muéstrame tu tarea a la cámara.", "echoes": False}]

    assert reply_from({"lines": line, "awaits": "homework_photo"}).awaits == "homework_photo"
    assert reply_from({"converse": "Rules.", "awaits": "homework"}).awaits == "homework"
    for mode in ("off", "identify", "explain"):
        assert reply_from({"converse": "Rules.", "board_help": mode}).board_help == mode
    assert reply_from({"converse": "Rules.", "board_help": "unknown"}).board_help == "off"
    assert reply_from({"lines": line}).awaits is None
    for odd in (None, "", "photo", "HOMEWORK_PHOTO", 1, ["homework"]):
        assert reply_from({"lines": line, "awaits": odd}).awaits is None
    # Nothing to say is no reply, whatever it waits for: the turn is the model's.
    assert reply_from({"lines": [], "awaits": "homework_photo"}) is None


def test_a_long_answer_fits_whole():
    # A worked example step by step and the next question after it.
    assert MAX_LINES >= 20
