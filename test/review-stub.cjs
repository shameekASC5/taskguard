'use strict';

/**
 * Stub reviewer server for tests.
 *
 * Answers the three review phases by inspecting the prompt, and — crucially —
 * exercises the TOOL LOOP: on the first reviewer step it requests a
 * run_command call, then on the next step it checks whether the tool result
 * actually arrived in the messages before deciding its verdict.
 *
 * That check is the point. It is what caught the bug where the reviewer was
 * told it had tools but was never given any.
 *
 * Usage: node test/review-stub.cjs <port-file>
 */

const http = require('node:http');
const fs = require('node:fs');

const portFile = process.argv[2];

/** Has a tool result been appended to the conversation yet? */
function hasToolResult(body) {
  // The messages array contains {"role":"tool","tool_call_id":...}. Match on
  // the parsed shape rather than a fragile escaped substring.
  try {
    const parsed = JSON.parse(body);
    return (parsed.messages || []).some((m) => m.role === 'tool');
  } catch {
    return false;
  }
}

/** Did the tool result contain real git output? */
function toolResultHasGitLog(body) {
  try {
    const parsed = JSON.parse(body);
    return (parsed.messages || []).some(
      (m) => m.role === 'tool' && String(m.content || '').includes('feat: adversarial review')
    );
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let payload;

    if (body.includes('FALSIFIABLE CLAIMS')) {
      payload = {
        choices: [{
          message: {
            content: JSON.stringify({
              claims: [{ id: 'c1', text: 'committed as 38e0483', kind: 'artifact', verify: 'git log' }],
            }),
          },
          finish_reason: 'stop',
        }],
      };
    } else if (body.includes('plan how to verify')) {
      payload = {
        choices: [{
          message: {
            content: JSON.stringify({
              checks: [{ claim: 'c1', how: 'check git log', command: 'git log', severity_if_false: 'high' }],
            }),
          },
          finish_reason: 'stop',
        }],
      };
    } else if (!hasToolResult(body)) {
      // Reviewer step 1: ask for a tool call.
      payload = {
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'run_command',
                arguments: JSON.stringify({ command: 'git log --oneline -3' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      };
    } else {
      // Reviewer step 2: the tool result is in the messages. Decide.
      const got = toolResultHasGitLog(body);
      payload = {
        choices: [{
          message: {
            content: JSON.stringify({
              findings: [{
                claim: 'c1',
                verdict: got ? 'confirmed' : 'unverified',
                severity: 'high',
                evidence: got
                  ? 'git log shows 38e0483 feat: adversarial review'
                  : 'the tool result did not contain the git log output',
                fix: '',
              }],
            }),
          },
          finish_reason: 'stop',
        }],
      };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  if (portFile) fs.writeFileSync(portFile, String(port));
  process.stdout.write(`${port}\n`);
});
