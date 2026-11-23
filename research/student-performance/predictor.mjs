// Exact exported ordinal model. All calculations stay on the device.
export function predict(model, values) {
  let score = 0;
  model.features.forEach((feature, i) => {
    if (!Number.isFinite(values[feature])) throw new Error(`Missing ${feature}`);
    score += ((values[feature] - model.mean[i]) / model.scale[i]) * model.coefficients_standardized[i];
  });
  const cdf = [0, ...model.thresholds.map(t => 1 / (1 + Math.exp(score - t))), 1];
  const probabilities = model.grades.map((grade, i) => ({grade, p: Math.max(0, cdf[i + 1] - cdf[i])}));
  const expected = probabilities.reduce((sum, row) => sum + row.grade * row.p, 0);
  const improvement = probabilities.filter(row => row.grade >= values.G2 + 2).reduce((sum, row) => sum + row.p, 0);
  return {expected, improvement, probabilities};
}
