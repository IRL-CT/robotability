#!/usr/bin/env node
/**
 * Manual QA demo for the score engine.
 *
 * Computes the Robotability score for one parity fixture row with the
 * TypeScript engine, then runs the same row through the Python
 * reference, and prints both numbers. The two numbers must match.
 *
 * Usage: node scripts/score/demo_score.mjs [row index]
 * The row index defaults to 90 (the first observed-range row).
 *
 * Node 24 strips TypeScript types natively, so this script imports the
 * .ts engine modules directly. It builds nothing and fetches nothing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeScore } from '../../src/lib/score/engine.ts';
import { FEATURES } from '../../src/lib/score/weights.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');
const fixturePath = join(repoRoot, 'src', 'lib', 'score', '__fixtures__', 'parity.json');
const referenceScript = join(repoRoot, 'pipeline', 'reference', 'compute_reference.py');

const rowIndex = Number(process.argv[2] ?? 90);
const rows = JSON.parse(readFileSync(fixturePath, 'utf8'));
if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rows.length) {
  console.error(`row index must be an integer in [0, ${rows.length - 1}]`);
  process.exit(1);
}
const row = rows[rowIndex];

console.log(`sample row index: ${rowIndex}`);
console.log('values:');
for (const feature of FEATURES) {
  const stat = row.stats[feature];
  console.log(
    `  ${feature}: value=${row.values[feature]} min=${stat.min} max=${stat.max}`,
  );
}

// TypeScript engine result.
const tsScore = computeScore(row.values, row.stats);
console.log(`TS engine score:     ${tsScore}`);

// Python reference result for the same row.
const workDir = mkdtempSync(join(tmpdir(), 'robotability-demo-'));
const csvPath = join(workDir, 'demo_row.csv');
const jsonPath = join(workDir, 'demo_row.json');
try {
  const header = ['row_id'];
  const cells = ['demo_row'];
  for (const feature of FEATURES) {
    header.push(feature, `${feature}__min`, `${feature}__max`);
    cells.push(
      String(row.values[feature]),
      String(row.stats[feature].min),
      String(row.stats[feature].max),
    );
  }
  writeFileSync(csvPath, header.join(',') + '\n' + cells.join(',') + '\n');

  const proc = spawnSync(
    'python3',
    [referenceScript, '--input', csvPath, '--output', jsonPath],
    { encoding: 'utf8' },
  );
  if (proc.status !== 0) {
    console.error(proc.stdout);
    console.error(proc.stderr);
    process.exit(1);
  }
  const reference = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const pyScore = reference[0].score;
  console.log(`Python ref score:    ${pyScore}`);

  const diff = Math.abs(tsScore - pyScore);
  console.log(`absolute difference: ${diff}`);
  if (diff > 1e-9) {
    console.error('FAIL: TS engine and Python reference disagree.');
    process.exit(1);
  }
  console.log('PASS: TS engine and Python reference match.');
} finally {
  // Remove the temporary CSV and JSON. Nothing survives outside the repo.
  rmSync(workDir, { recursive: true, force: true });
  console.log(`cleanup receipt: removed temp dir ${workDir}`);
}
