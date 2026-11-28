// SPDX-License-Identifier: Apache-2.0
// Original activities for an adult to use with a fifth grader. Only practiceTopic
// belongs in a tutor session. The worked examples and exit keys stay on this page.
import { languageNamed, SOURCE } from "./i18n.js";

const resources = [
  {
    id: "equivalent-fractions",
    skillId: "fracciones.equivalentes-y-simplificar",
    es: {
      title: "Una cinta, dos fracciones",
      goal: "Explicar por qué una misma longitud se puede expresar con dos fracciones equivalentes.",
      prompt: "Dibuja una cinta y pinta 2/3 de ella. Si divides la misma cinta en 12 partes iguales, ¿cuántas quedarán pintadas?",
      workedExample: "Divide cada tercio en 4 partes iguales. La cinta ahora tiene 12 partes y la pintura sigue en el mismo sitio. Los 2 tercios pintados se convirtieron en 8 partes. Así, 2/3 = 8/12.",
      plan: [
        "Pide que dibuje la cinta en el cuaderno, la divida en tercios y pinte dos. Que marque con una flecha dónde termina el color.",
        "Antes de añadir líneas, pregunta si la flecha tendrá que moverse. Deja que subdivida los tercios y compruebe su predicción.",
        "Pide que escriba las dos fracciones junto al dibujo y explique por qué cambian ambos números. Después, dale el ejercicio de salida en una hoja nueva.",
      ],
      rubric: [
        "Con apoyo, completa los otros dos tercios después de que marcas las divisiones del primero y cuenta las partes pintadas.",
        "Por su cuenta, subdivide todos los tercios por igual y escribe dos fracciones que coinciden con el dibujo.",
        "Al explicarlo, señala la misma longitud en ambas representaciones y justifica por qué multiplicó ambos números por el mismo factor.",
      ],
      exitTicket: "Representa 3/4 de otra cinta. Si la divides en 24 partes iguales, ¿cuántas quedan pintadas? Explica cómo lo sabes.",
      answerKey: "18 partes. Cada cuarto se divide en 6 y por eso 3/4 = 18/24. Acepta un dibujo que muestre las mismas partes pintadas.",
      skillName: "Fracciones equivalentes",
    },
    en: {
      title: "One ribbon, two fractions",
      goal: "Explain how two equivalent fractions can describe the same length.",
      prompt: "Draw a ribbon and shade 2/3 of it. If you split the same ribbon into 12 equal parts, how many will be shaded?",
      workedExample: "Split each third into 4 equal parts. The ribbon now has 12 parts and the shading ends in the same place. The 2 shaded thirds became 8 parts. So 2/3 = 8/12.",
      plan: [
        "Ask the learner to draw a ribbon in their notebook, split it into thirds and shade two. Have them mark where the shading ends with an arrow.",
        "Before adding lines, ask whether the arrow will need to move. Let them subdivide the thirds and check their prediction.",
        "Ask them to write both fractions beside the drawing and explain why both numbers change. Then give them the exit question on a fresh page.",
      ],
      rubric: [
        "With your divisions marked in one third, the learner completes the other two and counts the shaded parts.",
        "On their own, the learner splits every third equally and writes two fractions that match the drawing.",
        "When explaining, the learner points to the same length in both representations and explains why both numbers were multiplied by the same factor.",
      ],
      exitTicket: "Shade 3/4 of another ribbon. If you split it into 24 equal parts, how many are shaded? Explain how you know.",
      answerKey: "18 parts. Each quarter splits into 6, so 3/4 = 18/24. Accept a drawing showing the same shaded parts.",
      skillName: "Equivalent fractions",
    },
  },
  {
    id: "compare-fractions",
    skillId: "fracciones.comparar-distinto-denominador",
    es: {
      title: "¿Qué ciclista llegó más lejos?",
      goal: "Comparar dos fracciones de un mismo recorrido y justificar cuál representa una distancia mayor.",
      prompt: "Dos ciclistas salen del mismo punto y siguen la misma ruta. Uno recorre 3/4 de la ruta y el otro 5/8. ¿Quién llega más lejos?",
      workedExample: "Dibuja una sola ruta dividida en 8 tramos iguales. Cada cuarto ocupa 2 tramos, así que 3/4 llega a 6/8. El otro ciclista llega a 5/8. El primero avanza un tramo más.",
      plan: [
        "Pide una primera elección y escucha la razón. Dibuja una línea con la salida y la meta para representar la ruta completa.",
        "Pide que marque los cuartos y después los octavos sobre la misma línea. Que ubique a los dos ciclistas y compruebe su primera elección.",
        "Pregunta por qué importa que ambos recorran la misma ruta. Después, ofrece el ejercicio de salida y deja que elija cómo resolverlo.",
      ],
      rubric: [
        "Con la línea que ya dividiste, coloca al menos uno de los dos puntos en la marca correspondiente.",
        "Por su cuenta, coloca los dos puntos en una misma escala e identifica el que está más lejos de la salida.",
        "Al explicarlo, usa el dibujo o fracciones equivalentes para comparar partes del mismo tamaño y justificar su elección.",
      ],
      exitTicket: "En otra ruta, un ciclista recorre 5/6 del camino y otro 7/9 del mismo camino. ¿Quién llega más lejos? Muestra cómo lo comprobaste.",
      answerKey: "El primero. En una ruta de 18 tramos iguales, 5/6 = 15/18 y 7/9 = 14/18. El primer ciclista recorrió un tramo más. También sirve un dibujo a escala.",
      skillName: "Comparar fracciones",
    },
    en: {
      title: "Which cyclist went farther?",
      goal: "Compare two fractions of the same route and justify which represents a greater distance.",
      prompt: "Two cyclists start at the same point and follow the same route. One rides 3/4 of the route and the other rides 5/8. Who goes farther?",
      workedExample: "Draw one route split into 8 equal sections. Each quarter covers 2 sections, so 3/4 reaches the 6/8 mark. The other cyclist reaches 5/8. The first cyclist goes one section farther.",
      plan: [
        "Ask for a first choice and listen to the reason. Draw a line with a start and finish to represent the whole route.",
        "Ask the learner to mark quarters and then eighths on the same line. Have them place the two cyclists and check their first choice.",
        "Ask why it matters that both cyclists follow the same route. Then offer the exit question and let the learner choose a method.",
      ],
      rubric: [
        "Given a marked line, the learner places at least one cyclist at the corresponding point.",
        "On their own, the learner places both points on the same scale and identifies which is farther from the start.",
        "When explaining, the learner uses the drawing or equivalent fractions to compare equal-sized parts and justify the choice.",
      ],
      exitTicket: "On another route, one cyclist rides 5/6 of the way and the other rides 7/9 of that same route. Who goes farther? Show how you checked.",
      answerKey: "The first cyclist. On a route with 18 equal sections, 5/6 = 15/18 and 7/9 = 14/18. The first cyclist rode one section farther. An accurately scaled drawing also works.",
      skillName: "Comparing fractions",
    },
  },
  {
    id: "add-fractions",
    skillId: "fracciones.sumar-distinto-denominador",
    es: {
      title: "¿Cuánta agua hay en la jarra?",
      goal: "Sumar dos cantidades de agua medidas en litros usando partes del mismo tamaño.",
      prompt: "En una jarra vacía echas 2/3 de litro de agua y después 1/6 de litro. ¿Cuánta agua queda en la jarra?",
      workedExample: "Dibuja un litro dividido en 6 partes iguales. Los 2/3 de litro ocupan 4 de esas partes. Al añadir una parte más, tienes 4/6 + 1/6 = 5/6 de litro.",
      plan: [
        "Pide que dibuje un litro como una barra, marque los tercios y pinte la primera cantidad.",
        "Pregunta dónde cabría un sexto en la barra. Que añada las marcas necesarias y pinte la segunda cantidad con otro color, a continuación de la primera.",
        "Pide que señale qué cuenta cada número de su suma y que compruebe si el total es mayor que cada cantidad inicial. Luego ofrece el ejercicio de salida.",
      ],
      rubric: [
        "Después de que divides un tercio, completa las divisiones para que toda la barra quede en sextos.",
        "Por su cuenta, representa ambas cantidades en sextos, las suma y expresa el resultado en litros.",
        "Al explicarlo, señala cuánto mide cada parte y justifica por qué el denominador sigue siendo el mismo al contar las partes juntas.",
      ],
      exitTicket: "En otra jarra vacía echas 3/8 de litro y luego 1/4 de litro. ¿Cuánta agua hay en total? Anota la unidad y muestra la suma.",
      answerKey: "5/8 de litro. Como 1/4 = 2/8, la suma es 3/8 + 2/8 = 5/8. Un dibujo con un litro dividido en 8 partes iguales también muestra el total.",
      skillName: "Sumar fracciones",
    },
    en: {
      title: "How much water is in the jug?",
      goal: "Add two amounts of water measured in liters by using equal-sized parts.",
      prompt: "Pour 2/3 of a liter of water into an empty jug, then add 1/6 of a liter. How much water is in the jug?",
      workedExample: "Draw one liter split into 6 equal parts. The first 2/3 of a liter fills 4 of those parts. Adding one more part gives 4/6 + 1/6 = 5/6 of a liter.",
      plan: [
        "Ask the learner to draw a bar for one liter, mark thirds and shade the first amount.",
        "Ask where a sixth would fit on the bar. Have them add the marks they need and shade the second amount in another color, starting where the first amount ends.",
        "Ask them to show what each number in their sum counts and check that the total exceeds each original amount. Then offer the exit question.",
      ],
      rubric: [
        "After you split one third, the learner adds the remaining divisions to split the whole bar into sixths.",
        "On their own, the learner shows both amounts in sixths, adds them and gives the result in liters.",
        "When explaining, the learner points out the size of each part and explains why the denominator stays the same when the parts are counted together.",
      ],
      exitTicket: "Pour 3/8 of a liter and then 1/4 of a liter into another empty jug. How much water is there altogether? Include the unit and show your sum.",
      answerKey: "5/8 of a liter. Since 1/4 = 2/8, the sum is 3/8 + 2/8 = 5/8. A drawing of one liter split into 8 equal parts can also show the total.",
      skillName: "Adding fractions",
    },
  },
];

/** The adult's picker, in teaching order. */
export function listTeachingResources(language) {
  const locale = languageNamed(language) ?? SOURCE;
  return resources.map(({ id, [locale]: pack }) => ({ id, title: pack.title }));
}

/** Accept only a known activity. A missing or stale choice must not select a different lesson. */
export function teachingResource(id, language) {
  const resource = resources.find((entry) => entry.id === id);
  if (!resource) return null;
  const { skillName, ...pack } = resource[languageNamed(language) ?? SOURCE];
  const practiceTopic = `${skillName}. ${pack.prompt}`;
  return { id, skillId: resource.skillId, ...pack, plan: [...pack.plan], rubric: [...pack.rubric], practiceTopic };
}
