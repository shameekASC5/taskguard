#!/usr/bin/env node
'use strict';

/**
 * Stub LLM server for hook tests.
 *
 * Runs as a SEPARATE process. This matters: the tests invoke hook scripts with
 * spawnSync, which blocks the parent event loop. If the stub server lived in
 * the parent process it could never answer the hook's HTTP request, and the
 * hook would hang until timeout.
 *
 * Prints the chosen port on stdout, then serves canned completions.
 */

const http = require('node:http');

const payload = JSON.parse(process.env.STUB_PAYLOAD || '{}');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }));
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
