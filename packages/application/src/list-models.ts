import type {
  ClientAuthenticator,
  ModelCatalog,
  PublicModel,
} from '@rax-digital/domain';

export type ListModelsResult =
  | { readonly ok: true; readonly models: readonly PublicModel[] }
  | { readonly ok: false; readonly failure: 'authentication' };

/** Lists only configured public models permitted by the authenticated key. */
export class ListModelsService {
  public constructor(
    private readonly authenticator: ClientAuthenticator,
    private readonly catalog: ModelCatalog,
  ) {}

  public async execute(credential: string): Promise<ListModelsResult> {
    const authentication = await this.authenticator.authenticate(credential);
    return authentication.authenticated
      ? {
          ok: true,
          models: this.catalog.listAllowed(authentication.apiKey),
        }
      : { ok: false, failure: 'authentication' };
  }
}
