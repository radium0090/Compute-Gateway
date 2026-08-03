/** Extracts an RFC 6750 Bearer credential without retaining the header. */
export function bearerCredential(authorization: string | undefined): string {
  if (authorization === undefined) {
    return '';
  }
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? '';
}
