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
