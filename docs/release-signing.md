# Choosing and wiring a code-signing certificate

The north star is a **signed** Windows installer v1.0. Nothing in the tree
signs, and this note is the decision that unblocks it, with the facts and
the exact steps for each route.

The pipeline supports both kinds of code-signing service, so the choice
below is about which certificate to obtain. A signing-service route still
needs an installed executable/wrapper on the runner and explicit credential
injection; the current workflow does not install Azure/SignPath tooling or
map arbitrary service secrets automatically.

## The two routes

| | Classic certificate | Signing service |
|---|---|---|
| You get | a private key (a `.pfx`) | no private key — the provider signs the artifact |
| Examples | OV / EV Authenticode certs from a CA | **Azure Artifact Signing** (formerly Trusted Signing), **SignPath** |
| Pipeline input | `JARVIS_SIGNING_PFX_PATH` + `JARVIS_SIGNING_PFX_PASSWORD`, or `JARVIS_SIGNING_THUMBPRINT` | `JARVIS_SIGNING_COMMAND` — a command that takes the artifact path |
| Good for | an individual buying a cert outright | Azure: $9.99/month. SignPath: free for open source |

Both routes end in the same place: the installer is signed, the signature
is verified twice (with the signing tool and with
`Get-AuthenticodeSignature`), and a build that cannot sign **fails** rather
than publishing an unsigned artifact under a release that implies a
signature.

## Route A — Azure Artifact Signing (recommended for a v1.0 today)

- **Cost:** Basic plan **$9.99/month**, 5,000 signatures included,
  $0.005 per additional signature. (Premium is $99.99/month for 100,000.)
- **Eligibility:** individual identity validation, and the account holder
  must be **in the United States or Canada**. The billing account must be
  of type *Individual*. Organisational validation needs a legal entity.
- **What you do:**
  1. Create an Azure account and an Artifact Signing (Trusted Signing)
     account, and complete the individual identity validation.
  2. Create a **certificate profile** with the *Public Trust* type — a
     private trust profile produces a signature Windows will not trust.
  3. In this repository, set a repository **variable**
     `WINDOWS_SIGNING_COMMAND` to the command that signs an artifact, and
     the matching **secrets** for whatever that command needs (the signing
     account's endpoint and credentials).
- **Note:** the private key never leaves Azure, and never touches this
  machine or the CI runner. That is the main reason to prefer it over
  buying a `.pfx`.

## Route B — SignPath Foundation (free for open source)

- **Cost:** free, for OSI-approved open source projects. Daedalus is MIT
  licensed and public, so it qualifies in principle.
- **How it works:** the certificate is issued to *SignPath Foundation*,
  not to the maintainer — SignPath is the publisher of the signature. They
  sign through their own pipeline, and they verify that the artifact was
  built from the repository's source.
- **What you do:**
  1. Apply at <https://signpath.org/apply>. They review the project.
  2. Add the code signing policy to the project's home page — the exact
     wording SignPath requires is already in
     [`code-signing-policy.md`](code-signing-policy.md), and the policy
     page is linked from this repository's README.
  3. Turn on multi-factor authentication for the repository and the
     SignPath account, and organise the team into the roles the policy
     names (authors, reviewers, approvers).
  4. Integrate their signing into the release workflow and set
     `WINDOWS_SIGNING_COMMAND` to their CLI.
- **Two constraints worth knowing before you apply:**
  - SignPath requires the project to **"already be released in the form
    that should be signed"**. A project with no release at all may not
    qualify for the *first* signed release, so the first v1.0 may have to
    ship unsigned (or via Route A) and SignPath signs the releases after
    it.
  - Every release needs **manual approval** for signing, and they enforce
    file metadata restrictions: the product name and version attributes
    must be set consistently in every build.
- This route is the better long-term answer for a public open source
  project, and the application can be started in parallel with Route A.

## Route C — a classic OV/EV certificate

A CA-issued `.pfx` works today with no further code changes: put the
thumbprint in `JARVIS_SIGNING_THUMBPRINT` (or the `.pfx` in
`JARVIS_SIGNING_PFX_PATH` with `JARVIS_SIGNING_PFX_PASSWORD`) and the
pipeline signs with `signtool`, SHA-256, RFC 3161 timestamped.

This is the most expensive per year of the three, and it puts a
long-lived private key in the repository's secrets, which is the thing
Route A avoids. Use it if the other two do not work out.

## The steps after the credential exists

Whichever route you pick, the rest is the same:

1. **Secrets.** In the repository settings, set:
   - Route A: the secrets the signing command needs, plus the
     `WINDOWS_SIGNING_COMMAND` repository variable.
   - Route B: the same, pointing at SignPath's CLI.
   - Route C: `WINDOWS_SIGNING_CERT_PFX_BASE64` (the `.pfx`, base64) and
     `WINDOWS_SIGNING_PFX_PASSWORD`.
2. **Dry run.** Push the release branch and run the workflow by hand with
   `draft=true` and `allow_unsigned=true`. That publishes a **draft**
   release with the real artifacts and proves the whole path — build,
   smoke, publish — without putting anything in front of the public.
   Delete the draft afterwards.
3. **The real thing.** Create the `v1.0.0` tag. The tag push runs the
   workflow, which signs, verifies, smokes, and publishes.

## What the pipeline will not do

- Publish an unsigned build without `allow_unsigned=true`.
- Publish a build whose smoke failed.
- Publish a build whose version, provenance, installer hash, installed
  binary, or running-build identity disagree with the release record.

That is deliberate. A release pipeline that quietly ships something it
cannot vouch for is worse than no pipeline: it manufactures the trust the
artifact does not have.
