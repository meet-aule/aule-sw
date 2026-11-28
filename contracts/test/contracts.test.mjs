// Every schema must compile, every event type must have an example, and every
// example must validate against the envelope and its event schema.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateEnvelope = ajv.compile(read('envelope.schema.json'));

test('progressive steps and acknowledged views match the shared lesson examples', () => {
  const step = ajv.compile(read('board/step.v1.schema.json'));
  const view = ajv.compile(read('board/view.v1.schema.json'));
  const revision = 'bb5afa6e-ce3c-482e-8512-b7e8c79fb60f';
  for (const lesson of Object.values(read('board/lesson.v1.example.json'))) {
    for (const item of lesson) {
      assert.ok(step(item.step), JSON.stringify(step.errors));
      assert.ok(view({ revision, scene: item.scene, point: null }), JSON.stringify(view.errors));
    }
  }
  assert.equal(step({ action: 'mark', part: 'not a part' }), false);
  assert.equal(step({ action: 'add_bar', numerator: 1, denominator: 2, part: 'top' }), false);
  assert.equal(view({ revision, scene: null, point: null, words: 'text' }), false);
});

const types = readdirSync(new URL('events/', root))
  .filter((file) => file.endsWith('.schema.json'))
  .map((file) => file.replace('.schema.json', ''));

test('there is at least one event type', () => {
  assert.ok(types.length > 0);
});

for (const type of types) {
  test(type, () => {
    const schema = read(`events/${type}.schema.json`);
    assert.equal(schema.title, type, 'schema title must be the event type');
    assert.equal(schema.additionalProperties, false, 'event data must not allow unknown fields');
    const validateData = ajv.compile(schema);

    const example = read(`examples/${type}.json`);
    assert.equal(example.type, type);
    assert.ok(validateEnvelope(example), JSON.stringify(validateEnvelope.errors));
    assert.ok(validateData(example.data), JSON.stringify(validateData.errors));

    assert.equal(validateData({ ...example.data, unexpected: true }), false, 'unknown fields must be rejected');
  });
}

test('every example has a schema', () => {
  const examples = readdirSync(new URL('examples/', root)).map((file) => file.replace('.json', ''));
  assert.deepEqual(examples.sort(), [...types].sort());
});

// What the tutor shows on a screen: one schema, and one example per kind.
const visual = read('visuals/visual.v1.schema.json');
const validateVisual = new Ajv2020({ allErrors: true, strict: false }).compile(visual);
const visualExamples = readdirSync(new URL('visuals/examples/', root)).map((file) => file.replace('.json', ''));

test('every kind of visual has an example that validates', () => {
  assert.deepEqual(visualExamples.sort(), [...visual.properties.kind.enum].sort());
  for (const name of visualExamples) {
    const example = read(`visuals/examples/${name}.json`);
    assert.equal(example.kind, name);
    assert.ok(validateVisual(example), `${name}: ${JSON.stringify(validateVisual.errors)}`);
  }
});

test('a visual without what its kind needs, or with unknown fields, is rejected', () => {
  assert.equal(validateVisual({ kind: 'fraction_bars' }), false);
  assert.equal(validateVisual({ kind: 'dot_array', rows: 3 }), false);
  assert.equal(validateVisual({ kind: 'dot_array', rows: 3, columns: 40 }), false);
  assert.equal(validateVisual({ kind: 'exercise', lines: ['2 + 2 = ?'], html: '<b>x</b>' }), false);
  assert.equal(validateVisual({ kind: 'hologram' }), false);
});

test('a fraction can be drawn with nothing written next to it', () => {
  const fraction = { numerator: 3, denominator: 8 };
  assert.ok(validateVisual({ kind: 'fraction_circle', fractions: [{ ...fraction, labelled: false }] }));
  assert.ok(validateVisual({ kind: 'fraction_bars', fractions: [{ ...fraction, label: '3/8', labelled: true }] }));
  assert.equal(validateVisual({ kind: 'fraction_bars', fractions: [{ ...fraction, labelled: 'no' }] }), false);
});

// What the student can tap under the tutor's question: one schema and its examples.
const choices = read('choices/choices.v1.schema.json');
const validateChoices = new Ajv2020({ allErrors: true, strict: true }).compile(choices);
const choiceExamples = readdirSync(new URL('choices/examples/', root));

test('every example of choices validates, a single tap and several marked', () => {
  assert.ok(choiceExamples.length > 0);
  const examples = choiceExamples.map((file) => read(`choices/examples/${file}`));
  for (const [i, example] of examples.entries()) {
    assert.ok(validateChoices(example), `${choiceExamples[i]}: ${JSON.stringify(validateChoices.errors)}`);
  }
  assert.ok(examples.some((example) => example.multiple === true), 'an example marks several');
  assert.ok(examples.some((example) => example.multiple !== true), 'an example is answered with one tap');
});

test('choices without options, with too many, repeated, blank or with unknown fields are rejected', () => {
  assert.equal(validateChoices({}), false);
  assert.equal(validateChoices({ options: [] }), false);
  assert.equal(validateChoices({ options: ['a', 'b', 'c', 'd', 'e'] }), false);
  assert.equal(validateChoices({ options: ['Sí', 'Sí'] }), false);
  assert.equal(validateChoices({ options: ['Sí', ''] }), false);
  assert.equal(validateChoices({ options: ['Sí', '   '] }), false);
  assert.equal(validateChoices({ options: ['x'.repeat(41)] }), false);
  assert.equal(validateChoices({ options: ['Sí', 'No'], multiple: 'yes' }), false);
  assert.equal(validateChoices({ options: ['Sí', 'No'], html: '<b>Sí</b>' }), false);
  assert.equal(validateChoices({ options: [1, 2] }), false);
});
