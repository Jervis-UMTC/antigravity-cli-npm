import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodingAgent, resolveApiModel } from '../src/agent.js';

test('API-key aliases choose the newest matching Gemini model', async () => {
  const modelsLoader = async () => [
    'gemini-2.5-pro',
    'gemini-3.8-flash',
    'gemini-3.1-pro-preview',
    'gemini-3.7-flash',
    'gemini-3.5-flash-lite'
  ];
  assert.equal(await resolveApiModel('auto', { apiKey: 'k', modelsLoader }), 'gemini-3.1-pro-preview');
  assert.equal(await resolveApiModel('pro', { apiKey: 'k', modelsLoader }), 'gemini-3.1-pro-preview');
  assert.equal(await resolveApiModel('flash', { apiKey: 'k', modelsLoader }), 'gemini-3.8-flash');
  assert.equal(await resolveApiModel('flash-lite', { apiKey: 'k', modelsLoader }), 'gemini-3.5-flash-lite');
  assert.equal(await resolveApiModel('gemini-3.8-flash', { apiKey: 'k', modelsLoader }), 'gemini-3.8-flash');
});

test('direct API system instruction keeps shell responses plain and ends with Summary', async () => {
  let body = null;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    reasoning: 'auto',
    tools: { execute: async () => '' },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.\n\nSummary\nDone.' }] } }] }; } };
    }
  });

  await agent.prompt('check the project');
  const instruction = body.systemInstruction.parts[0].text;
  assert.match(instruction, /Never use emojis/);
  assert.match(instruction, /final section titled "Summary"/);
  assert.match(instruction, /Summary section must be the last section/);
});

test('direct API request propagates AbortSignal and rejects cancellation', async () => {
  const controller = new AbortController();
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    reasoning: 'auto',
    tools: { execute: async () => '' },
    fetchImpl: async (_url, options) => {
      started(options.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
  });

  const request = agent.prompt('hello', { signal: controller.signal });
  const passedSignal = await startedPromise;
  assert.equal(passedSignal, controller.signal);
  controller.abort();
  await assert.rejects(request, (error) => error?.name === 'AbortError');
});

test('direct API recovers an empty final response instead of printing a placeholder', async () => {
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    reasoning: 'auto',
    tools: { execute: async () => '' },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        async json() {
          return {
            candidates: [{ content: { role: 'model', parts: calls === 1 ? [] : [{ text: 'Project checked.' }] } }]
          };
        }
      };
    }
  });

  assert.equal(await agent.prompt('check the project'), 'Project checked.');
  assert.equal(calls, 2);
});

test('direct API can run long autonomous tasks beyond the old 20-step limit', async () => {
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async (_name, args) => `ok-${args.iteration}` },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            candidates: [{ content: {
              role: 'model',
              parts: calls <= 25
                ? [{ functionCall: { name: 'project_overview', args: { iteration: calls } } }]
                : [{ text: 'Long task completed.' }]
            } }]
          };
        }
      };
    }
  });

  assert.equal(await agent.prompt('perform a long task'), 'Long task completed.');
  assert.equal(calls, 26);
});

test('direct API detects repeated identical tool loops and asks for a different strategy', async () => {
  let calls = 0;
  const bodies = [];
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'same result' },
    fetchImpl: async (_url, options) => {
      calls += 1;
      bodies.push(JSON.parse(options.body));
      const parts = calls <= 3
        ? [{ functionCall: { name: 'search_files', args: { query: 'missing' } } }]
        : [{ text: 'Changed strategy.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  assert.equal(await agent.prompt('investigate'), 'Changed strategy.');
  assert.match(JSON.stringify(bodies[3].contents), /Do not repeat it again unchanged/);
});

test('direct API stops a permanently stagnant tool loop before exhausting the full step budget', async () => {
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'same result' },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_files', args: { query: 'missing' } } }] } }] };
        }
      };
    }
  });

  await assert.rejects(() => agent.prompt('investigate'), /without making progress/);
  assert.equal(calls, 6);
});

test('direct API forces a post-edit verification pass before accepting a final answer', async () => {
  let calls = 0;
  const toolCalls = [];
  const requestBodies = [];
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: {
      execute: async (name) => {
        toolCalls.push(name);
        return name === 'write_file' ? 'Wrote app.js.' : '1: updated';
      }
    },
    fetchImpl: async (_url, options) => {
      calls += 1;
      requestBodies.push(JSON.parse(options.body));
      const parts = calls === 1
        ? [{ functionCall: { name: 'write_file', args: { path: 'app.js', content: 'updated' } } }]
        : calls === 2
          ? [{ text: 'Done.' }]
          : calls === 3
            ? [{ functionCall: { name: 'read_file', args: { path: 'app.js' } } }]
            : [{ text: 'Updated and verified.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  assert.equal(await agent.prompt('update app.js'), 'Updated and verified.');
  assert.deepEqual(toolCalls, ['write_file', 'read_file']);
  assert.match(JSON.stringify(requestBodies[2].contents), /post-edit verification pass/);
});

test('direct API refuses completion when the model repeatedly ignores post-edit verification', async () => {
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'Wrote app.js.' },
    fetchImpl: async () => {
      calls += 1;
      const parts = calls === 1
        ? [{ functionCall: { name: 'write_file', args: { path: 'app.js', content: 'updated' } } }]
        : [{ text: 'Done without checking.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  await assert.rejects(
    () => agent.prompt('update app.js'),
    /did not perform a successful post-edit verification pass/
  );
  assert.equal(calls, 4);
});

test('direct API emits sanitized command events and marks failed commands as failed', async () => {
  const events = [];
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'Command failed.\nforced failure' },
    onEvent: (event) => events.push(event),
    fetchImpl: async () => {
      calls += 1;
      const parts = calls === 1
        ? [{ functionCall: { name: 'run_command', args: { command: 'deploy --token super-secret' } } }]
        : [{ text: 'Failure handled.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  assert.equal(await agent.prompt('run the check'), 'Failure handled.');
  const started = events.find((event) => event.type === 'command_started');
  const finished = events.find((event) => event.type === 'command_finished');
  assert.ok(started);
  assert.ok(finished);
  assert.equal(finished.success, false);
  assert.equal(events.some((event) => event.type === 'test_started' || event.type === 'test_finished'), false);
  assert.equal('command' in started, false);
  assert.equal('command' in finished, false);
});

test('direct API reports every file touched by apply_patch without undefined paths', async () => {
  const events = [];
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'Applied 2 patch hunks across 2 files.' },
    onEvent: (event) => events.push(event),
    fetchImpl: async () => {
      calls += 1;
      const parts = calls === 1
        ? [{ functionCall: { name: 'apply_patch', args: { changes: [
          { path: 'src/one.js', old_text: 'one', new_text: 'two' },
          { path: 'src/two.js', old_text: 'one', new_text: 'two' }
        ] } } }]
        : calls === 2
          ? [{ functionCall: { name: 'read_file', args: { path: 'src/one.js' } } }]
          : [{ text: 'Patched and verified.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  assert.equal(await agent.prompt('patch files'), 'Patched and verified.');
  assert.deepEqual(
    events.filter((event) => event.type === 'file_modified').map((event) => event.path),
    ['src/one.js', 'src/two.js']
  );
});

test('direct API retries transient model failures automatically', async () => {
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => '' },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 503, statusText: 'Unavailable', async json() { return { error: { message: 'busy' } }; } };
      }
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts: [{ text: 'Recovered.' }] } }] }; } };
    }
  });

  assert.equal(await agent.prompt('retry transient failures'), 'Recovered.');
  assert.equal(calls, 2);
});

test('direct API compacts oversized tool results before the next model request', async () => {
  let calls = 0;
  let secondBody = null;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'x'.repeat(60_000) },
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 2) secondBody = JSON.parse(options.body);
      const parts = calls === 1
        ? [{ functionCall: { name: 'project_overview', args: {} } }]
        : [{ text: 'Done.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  await agent.prompt('inspect project');
  const result = secondBody.contents.at(-1).parts[0].functionResponse.response.result;
  assert.ok(result.length < 25_000);
  assert.match(result, /tool output truncated/);
});

test('direct API compacts old tool exchanges during very long autonomous tasks', async () => {
  const requestContents = [];
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    history: Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `${index} ${'h'.repeat(8_000)}`
    })),
    tools: {
      execute: async (_name, args) => `result-${args.command} ${'x'.repeat(30_000)}`
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requestContents.push(body.contents);
      calls += 1;
      const parts = calls <= 75
        ? [{ functionCall: { name: 'run_command', args: { command: `check-${calls}` } } }]
        : [{ text: 'Long task completed.\n\nSummary\nCompleted.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  const answer = await agent.prompt('perform a long multi-step inspection');
  assert.match(answer, /Long task completed/);
  assert.equal(calls, 76);
  assert.ok(requestContents.some((contents) => JSON.stringify(contents).includes('Earlier conversation or tool activity was compacted')));
  assert.ok(Math.max(...requestContents.map((contents) => JSON.stringify(contents).length)) < 140_000);

  for (const contents of requestContents) {
    const firstResponse = contents.findIndex((content) => content.parts?.some((part) => part.functionResponse));
    if (firstResponse >= 0) {
      assert.ok(firstResponse > 0);
      assert.ok(contents[firstResponse - 1].parts?.some((part) => part.functionCall));
    }
  }
});

test('direct API retries an explicit provider context-limit error with a smaller history window', async () => {
  const sizes = [];
  let calls = 0;
  const history = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    text: `${index} ${'h'.repeat(9_000)}`
  }));
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    history,
    tools: { execute: async () => 'ok' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      sizes.push(JSON.stringify(body.contents).length);
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          async json() { return { error: { message: 'input token count exceeds the context limit' } }; }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { role: 'model', parts: [{ text: 'Recovered.\n\nSummary\nRecovered.' }] } }] };
        }
      };
    }
  });

  assert.match(await agent.prompt(`continue ${'q'.repeat(20_000)}`), /Recovered/);
  assert.equal(calls, 2);
  assert.ok(sizes[1] < sizes[0]);
  assert.ok(sizes[1] < 70_000);
});

test('direct API rejects a single oversized current prompt before sending it to the provider', async () => {
  let calls = 0;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'ok' },
    fetchImpl: async () => { calls += 1; throw new Error('should not send'); }
  });

  await assert.rejects(
    () => agent.prompt('x'.repeat(50_001)),
    /Current request is too large for direct API mode/
  );
  assert.equal(calls, 0);
});

test('direct API bounds combined current prompt and text attachment content', async () => {
  let sent = null;
  const attachmentText = `BEGIN-${'a'.repeat(90_000)}-END`;
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'ok' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      sent = body.contents.at(-1);
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }; } };
    }
  });

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-agent-current-turn-'));
  try {
    const file = path.join(temp, 'large.txt');
    await fs.writeFile(file, attachmentText, 'utf8');
    await agent.prompt('p'.repeat(45_000), { attachments: [{
      sourcePath: file,
      stagedPath: file,
      name: 'large.txt',
      mimeType: 'text/plain',
      kind: 'text',
      size: Buffer.byteLength(attachmentText)
    }] });
    const sentText = sent.parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
    assert.ok(sentText.length < 112_000);
    assert.match(sentText, /BEGIN-/);
    assert.match(sentText, /-END$/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
