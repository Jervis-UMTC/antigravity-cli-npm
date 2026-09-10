import assert from 'node:assert/strict';
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
        return name === 'write_file' ? 'Updated app.js.' : 'Checks passed.';
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
            ? [{ functionCall: { name: 'run_command', args: { command: 'npm test' } } }]
            : [{ text: 'Updated and verified.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  assert.equal(await agent.prompt('update app.js'), 'Updated and verified.');
  assert.deepEqual(toolCalls, ['write_file', 'run_command']);
  assert.match(JSON.stringify(requestBodies[2].contents), /post-edit verification pass/);
});

test('direct API does not accept read_file or git_diff alone as post-edit verification', async () => {
  let calls = 0;
  const toolCalls = [];
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: {
      execute: async (name) => {
        toolCalls.push(name);
        if (name === 'write_file') return 'Updated app.js.';
        if (name === 'read_file') return 'updated';
        return 'diff --git a/app.js b/app.js';
      }
    },
    fetchImpl: async () => {
      calls += 1;
      const parts = calls === 1
        ? [{ functionCall: { name: 'write_file', args: { path: 'app.js', content: 'updated' } } }]
        : calls === 2
          ? [{ text: 'Done.' }]
          : calls === 3
            ? [{ functionCall: { name: 'read_file', args: { path: 'app.js' } } }]
            : calls === 4
              ? [{ text: 'Checked the file.' }]
              : calls === 5
                ? [{ functionCall: { name: 'git_diff', args: {} } }]
                : [{ text: 'Checked the diff.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  await assert.rejects(
    () => agent.prompt('update app.js'),
    /did not perform a successful post-edit verification pass/
  );
  assert.deepEqual(toolCalls, ['write_file', 'read_file', 'git_diff']);
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

test('direct API reports failed commands as failed events without mislabeling them as tests', async () => {
  let calls = 0;
  const events = [];
  const agent = new CodingAgent({
    workspace: process.cwd(),
    displayWorkspace: process.cwd(),
    apiKey: 'test-key',
    model: 'gemini-3.8-flash',
    tools: { execute: async () => 'Command failed.\nexit 1' },
    onEvent: (event) => events.push(event),
    fetchImpl: async () => {
      calls += 1;
      const parts = calls === 1
        ? [{ functionCall: { name: 'run_command', args: { command: 'npm test' } } }]
        : [{ text: 'Command failure handled.' }];
      return { ok: true, status: 200, async json() { return { candidates: [{ content: { role: 'model', parts } }] }; } };
    }
  });

  assert.equal(await agent.prompt('run the check'), 'Command failure handled.');
  const finished = events.find((event) => event.type === 'command_finished');
  assert.equal(finished?.success, false);
  assert.equal(events.some((event) => event.type === 'test_started' || event.type === 'test_finished'), false);
});
