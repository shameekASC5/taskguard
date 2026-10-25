'use strict';

/**
 * Shared stdin/stdout plumbing for the VS Code adapter.
 *
 * Kept in one place so each adapter script is only the event translation.
 */

const fs = require('node:fs');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(obj) {
  // Trailing newline: some harnesses require a terminated line to parse stdout.
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

module.exports = { readStdin, emit };
