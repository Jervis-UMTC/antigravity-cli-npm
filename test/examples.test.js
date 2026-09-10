import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('title shell example parses JSON fields as data without eval', async () => {
  const script = await fs.readFile(new URL('../examples/title/title.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(script, /\beval\b/);
  assert.match(script, /jq -r '\.agent_state/);
  assert.match(script, /jq -r '\.workspace\.current_dir/);
});

test('provider UI examples are explicitly segregated from antigyc runtime design', async () => {
  const readme = await fs.readFile(new URL('../examples/README.md', import.meta.url), 'utf8');
  assert.match(readme, /Provider CLI reference examples/);
  assert.match(readme, /not.*examples of `antigyc` terminal output/i);
  assert.match(readme, /no status line, colors, model badges, emojis/i);
});
