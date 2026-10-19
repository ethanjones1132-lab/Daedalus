# Release pipeline

How a Jarvis release is built, signed, checked and published.

The north star for this repository is a **signed Windows installer v1.0 on
GitHub Releases, with build provenance / stale-binary prevention and the
eval harness green**. This document describes the part of that which
produces the installer and proves what it is.

## The pipeline

```
build ──► package ──► sign ──► hash ──► install ──► launch ──► health ──► chat
```

| Step | Script | What it proves |
|---|---|---|
| build | `scripts/release-build.ps1` | The NSIS installer exists and was made from a known commit. |
| package | `scripts/release-build.ps1` | Every shipped artifact is in one directory with its SHA-256. |
| sign | `scripts/release-build.ps1 -Sign`, `scripts/sign-installer.ps1` | The installer carries a valid Authenticode signature. |
| hash | `scripts/release-smoke.ps1` | The installer on disk is the one the record describes. |
| install | `scripts/release-smoke.ps1` | The installer really installs, and the installed binary is the recorded one. |
| launch | `scripts/release-smoke.ps1` | The packaged server starts. |
| health | `scripts/release-smoke.ps1` | The running build is the recorded build. |
| chat | `scripts/release-smoke.ps1` | The packaged runtime answers a request with a terminal frame. |

`.github/workflows/release.yml` runs exactly these scripts. The workflow
does not reimplement any of it, so the pipeline that publishes a release is
the same code a developer runs locally.

## Running it locally

```powershell
# build + package + write the release record
powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1

# ... and sign it (needs a certificate, see below)
powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1 -SkipTauriBuild -Sign

# check the result end to end
powershell -ExecutionPolicy Bypass -File scripts\release-smoke.ps1 `
    -ManifestPath dist\release\1.0.0\jarvis-release.json
```

The build writes to `dist/release/<version>/`:

```
dist/release/1.0.0/
├── Jarvis_1.0.0_x64-setup.exe   the NSIS installer
├── Jarvis.exe                    the app binary
├── index.js                      the bundled Bun server
├── mcp-stdio-server.js           the MCP stdio sidecar
├── prompts/                      the prompt tree
├── resources/                    claude_cli_proxy.py, opencode_go_openai_models.json
├── jarvis-release.json           the release record
└── SHA256SUMS.txt                the same hashes in the usual format
```

## The release record

`jarvis-release.json` is the single inspectable record of a release. It
names the version, the commit, whether the tree was dirty, the source-tree
digest, and every shipped artifact with its SHA-256 and size:

```json
{
  "schema": "jarvis.release/1",
  "product": "Jarvis",
  "version": "1.0.0",
  "git_sha": "21d4623…",
  "git_dirty": false,
  "built_at": "2026-10-19T12:00:00.0000000Z",
  "source_tree_sha256": "A1B2C3…",
  "files": [
    { "role": "installer", "name": "Jarvis_1.0.0_x64-setup.exe", "sha256": "…", "size_bytes": 0 }
  ],
  "prompts_tree_sha256": "…",
  "installer_name": "Jarvis_1.0.0_x64-setup.exe",
  "signed": true,
  "signature_status": "Valid",
  "signature_subject": "CN=…"
}
```

`role` is one of `installer`, `app_binary`, `server_bundle`, `mcp_stdio`,
`claude_proxy`, `go_models`.

Artifact paths in the record are **relative to the release directory**, so
the record stays portable and does not carry the build machine's directory
layout into a published release. `Resolve-JarvisManifestPath` resolves one
back against the directory the record lives in.

### The app binary is read from a real install

The release's `app_binary` entry is the binary **as it ships**, not the
copy left in `target/release`. Those are not the same bytes: Tauri's
bundler patches a copy of the exe with the bundle type information, and
that copy is what the installer carries. The difference is small — three
bytes of a Tauri-internal MIME-type table — but it means a record that
hashed the build-tree exe would describe a file no user ever runs.

So the build runs the installer once, into a scratch directory, and reads
the binary out of the install. The install is deterministic (the same
installer always lays down the same bytes), so the smoke reproduces those
exact bytes from a second install and the two records agree.

Two naming details follow from the same place:

- The installer lays the binary down as `home-base.exe` — the **crate**
  name. The product name (`Jarvis`) is used for the display name, the
  shortcuts and the install directory, not for the executable. The release
  directory stages the same bytes as `Jarvis.exe`.
- The smoke matches the installed binary by **hash**, not by name, because
  the hash is what the record actually asserts.

Both the build and the smoke uninstall their scratch install afterwards: a
silent install leaves an uninstall registry entry behind, and a stale one
shows up in Apps and Features as a broken install.

This is a different record from `.jarvis-deploy-manifest.json`, which
`scripts/build-and-deploy.ps1` writes for a **local deploy** onto the
Desktop. The deploy manifest describes a developer's machine; the release
record describes a shipped artifact. `scripts/verify-deploy.ps1` checks the
former and knows nothing about the latter.

## What the build refuses to do

**A version the surfaces disagree on.** The frontend, the backend, the
sidecar and the installer must all declare the same version. `Get-JarvisReleaseVersion`
reads all five declaration sites and fails the build, naming every
disagreeing source, when they differ. A v1.0 whose installer says 3.0.0 is
a mislabelled v1.0.

**A bundle that did not take the build identity.** The identity is folded
into the server bundle at build time with `bun build --define`, so `/health`
can report which build is answering rather than a static version string.
The build then *checks* the fold instead of trusting it: bun exits 0 even
when a define folds to a bare JS identifier, which produces a bundle that
throws at module load. `Test-JarvisBundleProvenance` looks for the commit
and the source-tree digest in the built file and for the absence of the
runtime environment lookup.

> This check exists because `cargo tauri build` used to rebuild the server
> bundle *without* the identity, silently undoing the bake done by
> `build-and-deploy.ps1`. The installed app then reported `git_sha: "dev"`
> and `/health` could not tell it apart from any other build. The frontend
> build is now a single shared script
> (`server-jarvis/src/build-frontend.ts`) that both the release build and
> the deploy build call, wired in as Tauri's `beforeBuildCommand`.

**An unsigned release presented as signed.** See below.

## Signing

Nothing in the tree signed before this pipeline existed, and "signed" is
the first word of the north star. Signing needs a code-signing
certificate, which only the owner can supply. Two ways to provide it:

| Input | Meaning |
|---|---|
| `JARVIS_SIGNING_THUMBPRINT` | SHA-1 thumbprint of a certificate already in the Windows certificate store. |
| `JARVIS_SIGNING_PFX_PATH` + `JARVIS_SIGNING_PFX_PASSWORD` | A `.pfx` to import into the current user's store before signing. |

Then:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1 -Sign
```

or, to sign an installer that already exists:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sign-installer.ps1 `
    -InstallerPath dist\release\1.0.0\Jarvis_1.0.0_x64-setup.exe
```

Both sign with SHA-256 and an RFC 3161 timestamp, then verify twice —
with `signtool verify /pa` and with `Get-AuthenticodeSignature` — because
a sign step that does not verify is a sign step that can silently do
nothing.

**Signing changes the bytes, so it happens before the record is written.**
A record written before signing would describe an installer whose hash no
longer matches the file on disk, and the smoke's hash check would correctly
fail on the release that had just been produced.

### The signing gate

`.github/workflows/release.yml` refuses to publish an unsigned build
unless it is run with `allow_unsigned=true`, which exists to validate the
pipeline and is not a way to ship a v1.0. The rule is that a release
published under a title implying trust must actually have it: a pipeline
that quietly publishes an unsigned installer is worse than no pipeline at
all, because it manufactures the trust the artifact does not have.

## The CI workflow

`.github/workflows/release.yml` triggers on a `v*` tag push, or manually
through `workflow_dispatch`. It runs on a Windows runner, because NSIS
bundles are Windows artifacts.

It needs two repository secrets:

| Secret | Purpose |
|---|---|
| `WINDOWS_SIGNING_CERT_PFX_BASE64` | The code-signing certificate, base64-encoded. |
| `WINDOWS_SIGNING_PFX_PASSWORD` | Its password. |

**Creating the tag is the release approval.** The workflow publishes what
the tag asks for; it does not decide what to release.

## What is verified, and what is not

| Claim | Status |
|---|---|
| The build identity is folded into the server bundle | verified — the build asserts it against the built file |
| The installer's hash matches the record | verified — the smoke re-hashes the file, and a tampered file fails |
| The installed binary matches the record | verified — the record's binary is read from a real install, and the smoke reproduces it from a second one |
| The running build matches the record | verified — the smoke compares `/health` against the record |
| The packaged runtime answers a request | verified — the smoke requires a terminal SSE frame |
| The installer is signed | verified when a certificate is supplied; **not applicable** otherwise, and the release is refused |
| The installer installs on a clean machine | partially — the smoke installs into a scratch directory, not a clean machine image |
| The signed installer passes SmartScreen | **not verified** — that needs a real download and a real certificate, and the signature's reputation depends on the CA |
| The GUI starts cold on real hardware | **not verified** — the smoke launches the server bundle, not the desktop window. This is tracked separately (DD-EO5) |

## Tests

`scripts/release-pipeline.Tests.ps1` covers the decisions the pipeline
makes, without needing an installer, a certificate or an inference
backend:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command `
    "Invoke-Pester -Script scripts\release-pipeline.Tests.ps1 -EnableExit"
```

It is a behavioural suite, not a source-text suite: it calls the same
functions the pipeline calls and asserts on what they return. The
source-tree digest test pins the algorithm to the original implementation
rather than to itself, because that digest is what every deploy manifest
ever written is verified against.
