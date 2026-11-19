import type { CustomerMailerPort } from '@rax-digital/application';

export interface ResendCustomerMailerOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

function emailText(
  greetingName: string,
  action: string,
  url: string,
  expiry: string,
): string {
  return [
    `Hello ${greetingName},`,
    '',
    `${action}:`,
    url,
    '',
    `This link ${expiry}. If you did not request it, you can ignore this email.`,
    '',
    'RAX Compute Gateway',
  ].join('\n');
}

/** Minimal transactional-email adapter; response bodies are never logged. */
export class ResendCustomerMailer implements CustomerMailerPort {
  private readonly request: typeof fetch;

  public constructor(private readonly options: ResendCustomerMailerOptions) {
    if (options.apiKey.trim() === '' || options.from.trim() === '') {
      throw new TypeError('Customer mail configuration is incomplete');
    }
    this.request = options.fetch ?? fetch;
  }

  public sendEmailVerification(input: {
    readonly email: string;
    readonly displayName: string;
    readonly verificationToken: string;
  }): Promise<void> {
    const url = `${this.options.origin}/console/verify?token=${encodeURIComponent(input.verificationToken)}`;
    return this.send({
      to: input.email,
      subject: 'Verify your RAX Compute Gateway account',
      text: emailText(
        input.displayName,
        'Verify your email address by opening this link',
        url,
        'expires in 24 hours',
      ),
    });
  }

  public sendPasswordReset(input: {
    readonly email: string;
    readonly displayName: string;
    readonly resetToken: string;
  }): Promise<void> {
    const url = `${this.options.origin}/console/reset-password?token=${encodeURIComponent(input.resetToken)}`;
    return this.send({
      to: input.email,
      subject: 'Reset your RAX Compute Gateway password',
      text: emailText(
        input.displayName,
        'Reset your password by opening this link',
        url,
        'expires in one hour',
      ),
    });
  }

  private async send(input: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
  }): Promise<void> {
    const response = await this.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error('Transactional email delivery failed');
    }
  }
}
