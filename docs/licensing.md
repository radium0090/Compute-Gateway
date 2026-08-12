# Licensing

## Project license

RAX Compute Gateway source code and documentation are licensed under the Apache License,
Version 2.0. The complete terms and project notice are in the root `LICENSE` and
`NOTICE` files. This document is operational guidance, not legal advice or a
substitute for those files.

## Source headers

New source files do not require long license blocks. If project policy uses
SPDX identifiers, use:

```text
SPDX-License-Identifier: Apache-2.0
```

Do not add third-party copyright notices to RAX Compute Gateway-authored files unless
required. Preserve notices on copied or substantially derived material.

## Contributions

Contributions are accepted under the repository license using Developer
Certificate of Origin sign-off. A Contributor License Agreement is not required
for the initial project unless legal counsel and maintainers later decide
otherwise through a documented governance change.

## Dependencies

Permissive dependencies such as Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause,
ISC, and compatible public-domain dedications are generally acceptable after
automated and human review. Copyleft, source-available, non-commercial,
field-of-use, and custom licenses require explicit legal/maintainer approval.

CI scans dependency licenses and fails on detected license issues at the
configured severity. Container base images, generated SDK dependencies, example
code, and bundled assets are included in release review.

## Provider names and SDKs

Provider names and model identifiers are used for factual interoperability.
They remain trademarks of their owners. RAX Compute Gateway MUST NOT imply endorsement or
bundle provider API access. Users bring credentials and remain responsible for
provider terms, acceptable-use rules, data handling, and charges.

## Documentation and examples

Repository documentation and original examples follow Apache-2.0 unless a file
states otherwise. Do not copy provider documentation or examples beyond what
their licenses permit; link to authoritative sources and write original
interoperability explanations.

## Release checklist

- Confirm `LICENSE`, `NOTICE`, README license statement, and package metadata.
- Run dependency and container license scans.
- Review generated code notices and provider SDK licenses.
- Confirm contributor sign-offs.
- Record any approved exception with scope, rationale, and owner.
- Consult qualified counsel before changing license or adding commercial terms.
