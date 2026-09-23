import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/vay2017-metadata-reader-bootstrap.yml', import.meta.url), 'utf8');
const runner = await readFile(new URL('./run-vay2017-metadata-reader-bootstrap.sh', import.meta.url), 'utf8');

test('bootstrap is separately dispatched, protected, serialized, and fixed', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment:\s+vay2017-metadata-preflight/);
  assert.match(workflow, /group:\s+vay2017-metadata-runner/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(workflow, /inputs:|workflow_call:/);
  assert.match(runner, /stateMachine:vay2017-metadata-reader-bootstrap/);
  assert.match(runner, /start-execution[\s\S]*--input '\{\}'/);
  assert.match(runner, /Verified isolated metadata-reader provisioning succeeded/);
  assert.doesNotMatch(runner, /get-secret-value|password=|VAY2017_DB_PASSWORD=/i);
});
