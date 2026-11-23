import assert from 'node:assert/strict';
import fs from 'node:fs';
import {predict} from './predictor.mjs';

const result=JSON.parse(fs.readFileSync(new URL('./results/results.json',import.meta.url)));
let checks=0;
for (const dataset of Object.values(result.datasets)) {
  for (const model of Object.values(dataset.full_data_models_for_explorer)) {
    const sample=model.synthetic_check;
    const prediction=predict(model,sample.features);
    assert.ok(Math.abs(prediction.expected-sample.expected_grade)<1e-10);
    assert.ok(Math.abs(prediction.probabilities.reduce((s,row)=>s+row.p,0)-1)<1e-10);
    assert.ok(prediction.probabilities.every(row=>row.p>=0&&row.p<=1));
    assert.ok(prediction.expected>=0&&prediction.expected<=20);
    assert.ok(prediction.improvement>=0&&prediction.improvement<=1);
    assert.equal(predict(model,{...sample.features,G2:20}).improvement,0);
    checks+=6;
  }
  assert.equal(dataset.models.extended.n,dataset.n);
  assert.equal(dataset.fold_parameters.length,20);
  assert.ok(dataset.school_transfer.every(r=>r.train_n+r.test_n===dataset.n));
  checks+=3;
}
assert.ok(result.optimization_audit.all_converged);
const html=fs.readFileSync(new URL('./explorer.html',import.meta.url),'utf8');
assert.ok(!html.includes('__MODEL_DATA__')&&!html.includes('__PREDICT_FUNCTION__'));
assert.ok(Buffer.byteLength(html)<1000000);
assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(html));
checks+=4;
console.log(JSON.stringify({passed:checks,modelParityTolerance:1e-10,optimization:result.optimization_audit}));
