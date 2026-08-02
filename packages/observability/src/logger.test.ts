import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('redacts forbidden credential fields from structured logs', () => {
    let output = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString('utf8');
        callback();
      },
    });
    const logger = createLogger({
      environment: 'test',
      level: 'info',
      destination,
    });

    logger.info(
      {
        authorization: 'Bearer real-looking-secret',
        databaseUrl: 'postgresql://user:secret@host/db',
      },
      'safe event',
    );

    expect(output).toContain('<redacted>');
    expect(output).not.toContain('real-looking-secret');
    expect(output).not.toContain('postgresql://user:secret@host/db');
  });
});
