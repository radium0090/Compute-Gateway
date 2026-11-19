import { describe, expect, it } from 'vitest';

import { ResendCustomerMailer } from './customer-mailer.js';

describe('ResendCustomerMailer', () => {
  it('sends a bounded verification link through the configured sender', async () => {
    const calls: {
      readonly url: string;
      readonly options: RequestInit | undefined;
    }[] = [];
    const request: typeof fetch = (input, options) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ url, options });
      return Promise.resolve(new Response(null, { status: 202 }));
    };
    const mailer = new ResendCustomerMailer({
      apiKey: 'secret-resend-key',
      from: 'RAX <console@example.com>',
      origin: 'https://gateway.example.com',
      fetch: request,
    });
    await mailer.sendEmailVerification({
      email: 'owner@example.com',
      displayName: 'Owner',
      verificationToken: 'token/value',
    });
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.options?.body).toContain(
      'https://gateway.example.com/console/verify?token=token%2Fvalue',
    );
    expect(calls[0]?.options?.body).not.toContain('secret-resend-key');
  });

  it('fails closed when the mail provider rejects delivery', async () => {
    const mailer = new ResendCustomerMailer({
      apiKey: 'secret-resend-key',
      from: 'RAX <console@example.com>',
      origin: 'https://gateway.example.com',
      fetch: () => Promise.resolve(new Response(null, { status: 400 })),
    });
    await expect(
      mailer.sendPasswordReset({
        email: 'owner@example.com',
        displayName: 'Owner',
        resetToken: 'token',
      }),
    ).rejects.toThrow('Transactional email delivery failed');
  });
});
