import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'dist', 'cli.js');

describe('compiled lifecycle Companion option dispatch', () => {
  it.each(['start', 'restart'])('accepts Companion value flags for %s before execution', command => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-companion-cli-'));
    try {
      const result = spawnSync(process.execPath, [CLI, command,
        '--companion-secret-file', '/definitely/missing/companion-secret',
        '--companion-bot', 'local_test_bot'], {
        env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 15_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(2);
      expect(output).not.toContain('未知参数');
      expect(output).not.toContain('--companion-secret-file');
      expect(output).not.toContain('--companion-bot');
      expect(output).toContain('companion_secret_invalid');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
