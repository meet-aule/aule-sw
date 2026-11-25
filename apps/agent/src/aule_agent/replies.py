"""The fixed replies a person hears when a safety gate stops a turn, when a
session is stopped because the student is not working, when the clock asks
for a break or says the end is near, and when the tutor's model fails.

They are written and reviewed by people, in every supported language, and are
never generated or translated by a model: what is said after a gate stops a
turn must not depend on the thing that was just stopped.
"""

REPLIES: dict[str, dict[str, str]] = {
    # Said once, when the student keeps fooling around: a session never ends
    # without a warning.
    "not_working_warn": {
        "es": "Me parece que hoy no tenemos muchas ganas de trabajar, y no pasa nada. Pero si "
        "seguimos así, lo dejamos por hoy y le aviso a tu familia. ¿Lo intentamos una vez más?",
        "en": "It seems we don't feel much like working today, and that's all right. But if we "
        "carry on like this, we stop for today and I let your family know. Shall we try once more?",
    },
    "not_working_end": {
        "es": "Lo dejamos aquí por hoy. Le aviso a tu familia para buscar otro momento. "
        "¡Nos vemos pronto!",
        "en": "We stop here for today. I'll let your family know so we can find another time. "
        "See you soon!",
    },
    # A student who says something out of place is brought back to the work,
    # with no other plan offered: a game here would reward it.
    "redirect": {
        "es": "De eso no puedo hablar. Sigamos con lo nuestro.",
        "en": "I can't talk about that. Let's get back to our work.",
    },
    "child_support": {
        "es": "Gracias por contármelo. Si algo te incomodó o te hizo sentir en peligro, busca a "
        "un adulto de confianza que pueda ayudarte. No tienes que resolverlo a solas.",
        "en": "Thank you for telling me. If something made you feel uncomfortable or unsafe, "
        "find a trusted adult who can help. You don't have to handle it alone.",
    },
    "self_harm_support": {
        "es": "Siento que estés pasando por algo tan difícil. Cuéntaselo ahora mismo a un adulto "
        "de confianza que esté cerca; si hay peligro inmediato, pídele que contacte a "
        "emergencias.",
        "en": "I'm sorry things feel so difficult. Tell a trusted adult nearby right now; if "
        "there is immediate danger, ask them to contact emergency services.",
    },
    "unavailable": {
        "es": "Ahora mismo no puedo responder con seguridad. Inténtalo de nuevo en un momento o "
        "pide ayuda a un adulto de confianza.",
        "en": "I can't respond safely right now. Try again in a moment or ask a trusted adult "
        "for help.",
    },
    # The three below end on going back to the work. Worded as "afterwards",
    # not "once you are safe": the gate reads the second as a danger still
    # open and then stops a plain "let's carry on" (measured with the cases
    # in evals/physical-safety).
    "adult_help": {
        "es": "Primero, pide ayuda a un adulto de confianza que esté cerca. No lo intentes tú. "
        "Después seguimos con lo que estábamos haciendo.",
        "en": "First, ask a trusted adult nearby for help. Don't try it yourself. After that, "
        "we'll carry on with what we were doing.",
    },
    "adult_help_again": {
        "es": "No lo intentes tú; pide ayuda a un adulto de confianza cercano. Después seguimos.",
        "en": "Don't try it yourself; ask a trusted adult nearby for help. After that, we'll "
        "carry on.",
    },
    "adult_help_wait": {
        "es": "Busca a un adulto de confianza que esté cerca; deja que se encargue. Después "
        "seguimos con lo nuestro.",
        "en": "Find a trusted adult nearby and let them handle it. After that, we'll carry on "
        "with our work.",
    },
    "clarify": {
        "es": "No entendí bien qué quieres hacer. ¿Me lo cuentas de otra manera?",
        "en": "I didn't quite get what you want to do. Can you tell me another way?",
    },
    # The clock. Said in a quiet moment, never over a reply: a session does not
    # end without a warning.
    "five_minutes_left": {
        "es": "Nos quedan cinco minutos. Terminemos esto con calma.",
        "en": "We have five minutes left. Let's finish this without rushing.",
    },
    "two_minutes_left": {
        "es": "Nos quedan dos minutos. Terminemos esto con calma.",
        "en": "We have two minutes left. Let's finish this without rushing.",
    },
    # The student said goodbye first.
    "farewell": {
        "es": "¡Chau! Gracias por la sesión de hoy. Nos vemos pronto.",
        "en": "Bye! Thanks for today's session. See you soon.",
    },
    "goodbye": {
        "es": "Se nos acabó el tiempo por hoy. ¡Buen trabajo! Hasta la próxima.",
        "en": "That is all our time for today. Good work! See you next time.",
    },
    # An active break: one short thing to do away from the work, then back. A
    # break can come a minute into a session, when the student says they are
    # tired, so no line says how long the work has gone on.
    "break_stars": {
        "es": "Hagamos una pausa para recargar energía. Ponte de pie donde tengas espacio y "
        "haz quince saltos de estrella, abriendo brazos y piernas. Cuando vuelvas, avísame y "
        "seguimos.",
        "en": "Let's take a break to recharge. Stand up where you have room and do fifteen "
        "star jumps, opening your arms and legs. Tell me when you are back and we'll carry "
        "on.",
    },
    "break_balloon": {
        "es": "Buen momento para una pausa. Busca una postura cómoda, pon las manos en la "
        "barriga y respira despacio cinco veces, inflándola como un globo. Cuando termines, "
        "avísame y seguimos.",
        "en": "A good moment for a break. Sit comfortably, put your hands on your belly and "
        "breathe slowly five times, filling it like a balloon. Tell me when you are done and "
        "we'll carry on.",
    },
    "break_mirror": {
        "es": "Toca una pausa. Ponte de pie y toca tu nariz, tus rodillas y tus hombros, cada "
        "vez más rápido. Después sacude las manos y los pies. Cuando vuelvas, avísame y "
        "seguimos.",
        "en": "Time for a break. Stand up and touch your nose, your knees and your shoulders, "
        "faster each time. Then shake your hands and feet. Tell me when you are back and "
        "we'll carry on.",
    },
    "break_cat": {
        "es": "Vamos con una pausa corta. Estira los brazos hacia arriba como un gato que "
        "despierta, gira despacio el cuello a un lado y al otro, y toma agua si tienes a la "
        "mano. Cuando vuelvas, avísame y seguimos.",
        "en": "Time for a short break. Stretch your arms up like a cat waking up, turn your "
        "neck slowly to one side and the other, and drink some water if you have some nearby. "
        "Tell me when you are back and we'll carry on.",
    },
    # A student who has said nothing for a while: asked once, then the session closes.
    "still_there": {
        "es": "¿Sigues ahí? Si quieres seguir, dime algo.",
        "en": "Are you still there? Say something if you want to carry on.",
    },
    "idle_goodbye": {
        "es": "Parece que tuviste que irte. Cierro la sesión por ahora; cuando quieras, empezamos "
        "otra. ¡Hasta pronto!",
        "en": "It looks like you had to go. I'll close the session for now; we can start another "
        "one whenever you like. See you soon!",
    },
    "break_over": {
        "es": "Ya pasó la pausa. ¿Seguimos donde nos quedamos?",
        "en": "The break is over. Shall we carry on where we left off?",
    },
    # Said while a tool does its work, in place of whatever the model wrote in
    # that step: short, true whatever the tool is, never the model's own words.
    "meanwhile_see": {"es": "A ver.", "en": "Let's see."},
    "meanwhile_look": {"es": "Veamos.", "en": "Let me see."},
    "meanwhile_moment": {"es": "Un momento.", "en": "One moment."},
    # Said when the tutor drew something and had no words left for it.
    "look_at_screen": {
        "es": "Mira la pantalla y cuéntame qué ves.",
        "en": "Look at the screen and tell me what you see.",
    },
    "context_limit": {
        "es": "Necesito ayuda de un adulto para seguir con seguridad. Pídele que revise lo que "
        "pasa y vuelva a iniciar la sesión.",
        "en": "I need an adult's help to continue safely. Ask them to check what's happening and "
        "start the session again.",
    },
    # Said when the tutor's model failed or took too long, before the turn is
    # tried once more: true whatever happens next. No wires or cables: the
    # physical-safety gate reads what the tutor said with the next turn.
    "hold_on": {
        "es": "Dame un momentito, se me enredaron las ideas.",
        "en": "Give me a moment, my ideas got all tangled up.",
    },
    # Said when the tutor's model cannot answer for the rest of the session,
    # which then ends.
    "tutor_unavailable": {
        "es": "Lo siento, algo no me está funcionando y no puedo seguir ahora. Lo intentamos "
        "otra vez más tarde. ¡Hasta pronto!",
        "en": "Sorry, something isn't working for me and I can't carry on right now. Let's try "
        "again later. See you soon!",
    },
}

# Consecutive physical hazards get the full reply first and then alternate two
# shorter reminders. Each one stands alone: none assumes the hazard is the same
# one or that it is over.
ADULT_HELP_SEQUENCE = ("adult_help", "adult_help_again", "adult_help_wait")

# Replies the following turn may answer ("ya vino mi mamá", the same thing said
# another way). They stay in the conversation so that it has something to
# refer to.
ANSWERABLE = frozenset({*ADULT_HELP_SEQUENCE, "clarify"})

# One activity per break, in turn: one that wakes up, then one that calms. They
# are the four the session engine proposes, shortened to be heard.
BREAKS = ("break_stars", "break_balloon", "break_mirror", "break_cat")

# What is said while a tool works, in turn.
MEANWHILE = ("meanwhile_see", "meanwhile_look", "meanwhile_moment")


def reply(key: str, language: str) -> str:
    return REPLIES[key][language]
