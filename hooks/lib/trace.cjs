'use strict';

/**
 * Trace logging for the ledger hooks.
 *
 * The event probe proves the HARNESS fires an event. It does NOT prove OUR
 * script ran. This module logs from inside our own scripts, so we can tell
 * "hook never invoked" apart from "hook ran but did nothing".
 *
 * Log: ~/.copilot/hooks/ledger/hook-trace.log.jsonl
 * Disable with LEDGER_TRACE=0.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG = process.env.LEDGER_TRACE_LOG
  || path.join(os.homedir(), '.copilot', 'hooks', 'ledger', 'hook-trace.log.jsonl');

function trace(script, phase, detail = {}) {
  if (process.env.LEDGER_TRACE === '0') return;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      script,
      phase,
      ...detail,
    })}\n`);
  } catch {
    // Tracing must never break a hook.
  }
}

module.exports = { trace, LOG };
