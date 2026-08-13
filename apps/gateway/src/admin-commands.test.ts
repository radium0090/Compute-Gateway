import { describe, expect, it, vi } from 'vitest';

import type { AdminPrincipal } from '@rax-digital/application';
import { adminUserId } from '@rax-digital/domain';

import { executeAdminCommand } from './admin-commands.js';

const principal: AdminPrincipal = {
  id: adminUserId('00000000-0000-4000-8000-000000000001'),
  email: 'owner@rax-digital.com',
  displayName: 'RAX Owner',
  mustChangePassword: true,
};

describe('administrator operator commands', () => {
  it('reads the temporary password outside command arguments', async () => {
    const bootstrapAdmin = vi.fn(() => Promise.resolve(principal));
    const output = vi.fn<(value: string) => void>();
    await executeAdminCommand(
      [
        'create',
        '--email',
        'owner@rax-digital.com',
        '--display-name',
        'RAX Owner',
      ],
      {
        service: { bootstrapAdmin },
        readPassword: () => Promise.resolve('temporary password 123'),
        output,
      },
    );

    expect(bootstrapAdmin).toHaveBeenCalledWith({
      email: 'owner@rax-digital.com',
      displayName: 'RAX Owner',
      password: 'temporary password 123',
    });
    expect(output).toHaveBeenCalledWith(
      'administrator created: owner@rax-digital.com\n',
    );
    expect(output).not.toHaveBeenCalledWith(
      expect.stringContaining('temporary'),
    );
  });

  it('rejects missing and unknown flags before reading a password', async () => {
    const readPassword = vi.fn(() => Promise.resolve('unused password value'));
    await expect(
      executeAdminCommand(['create', '--password', 'unsafe'], {
        service: { bootstrapAdmin: () => Promise.resolve(principal) },
        readPassword,
        output: () => undefined,
      }),
    ).rejects.toThrow(/Usage/);
    expect(readPassword).not.toHaveBeenCalled();
  });
});
