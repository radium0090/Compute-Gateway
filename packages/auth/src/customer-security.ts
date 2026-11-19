import {
  adminTokenHash,
  customerTokenHash,
  type CustomerTokenHash,
} from '@rax-digital/domain';

import {
  NodeAdminSecurity,
  type AdminSecurityOptions,
} from './admin-security.js';

/**
 * Customer credential primitives backed by the reviewed administrator
 * implementation but branded and configured with an independent pepper.
 */
export class NodeCustomerSecurity {
  private readonly delegate: NodeAdminSecurity;

  public constructor(options: AdminSecurityOptions) {
    this.delegate = new NodeAdminSecurity(options);
  }

  public get dummyPasswordHash(): string {
    return this.delegate.dummyPasswordHash;
  }

  public hashPassword(password: string): Promise<string> {
    return this.delegate.hashPassword(password);
  }

  public verifyPassword(password: string, encoded: string): Promise<boolean> {
    return this.delegate.verifyPassword(password, encoded);
  }

  public generateOpaqueToken(): string {
    return this.delegate.generateOpaqueToken();
  }

  public hashOpaqueToken(token: string): CustomerTokenHash {
    return customerTokenHash(this.delegate.hashOpaqueToken(token));
  }

  public verifyOpaqueToken(
    token: string,
    expected: CustomerTokenHash,
  ): boolean {
    return this.delegate.verifyOpaqueToken(token, adminTokenHash(expected));
  }
}
