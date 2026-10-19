# Code signing policy

This is the code signing policy for **Jarvis** (the Daedalus repository,
<https://github.com/ethanjones1132-lab/Daedalus>).

Free code signing provided by [SignPath.io](https://about.signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

## Who may sign

Only the maintainers of this repository, and only for releases built from
this repository's own source.

| Role | Members |
|---|---|
| Committers and reviewers | [Maintainers](https://github.com/ethanjones1132-lab/Daedalus/people) |
| Approvers (may authorise a signing request) | [Owner](https://github.com/ethanjones1132-lab) |

The team that maintains the code is the team that authorises its signing.
Every signing request is approved by a member of the approver role before
it is signed.

## How releases are signed

- Releases are built by the GitHub Actions workflow
  [`.github/workflows/release.yml`](../.github/workflows/release.yml) from
  the tagged source. The build is what produces the artifact, and the
  signing step runs inside that same workflow.
- The signed artifact is the NSIS installer
  (`Jarvis_<version>_x64-setup.exe`). Its SHA-256 is recorded in
  `SHA256SUMS.txt` and in the release record `jarvis-release.json`, both of
  which are published with the release.
- Every release needs an explicit approval before it is signed. The
  workflow refuses to publish an unsigned build unless it is run with
  `allow_unsigned=true`, which exists to validate the pipeline and is not
  how a release is shipped.
- The build stamps the commit it came from into the server bundle, and the
  release smoke re-reads that stamp from the running system and compares it
  to the release record. A release whose runtime does not identify itself
  as the recorded build fails before it is published.

## What is checked before signing

The pipeline does not sign on trust. Before the signature is applied, and
again before the release is published, it checks that:

- the version declared by the frontend, the backend, the sidecar and the
  installer are all the same;
- the server bundle carries the commit and source-tree digest of the build
  it claims to be;
- the installer on disk hashes to what the release record says;
- the installer really installs, and the installed binary is the one the
  record describes;
- the packaged runtime starts, reports the recorded build identity, and
  answers a request with a terminal frame.

## Privacy

This program does not transfer any information to other networked systems
unless specifically requested by the user or the person installing or
operating it.

## Contact

Questions about this policy: open an issue on the repository, or contact
the maintainer at <https://github.com/ethanjones1132-lab>.
