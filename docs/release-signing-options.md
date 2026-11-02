# Windows code-signing options — comparison for DD-040

**Purpose:** one comparison an owner can accept or reject, to unblock a **signed**
Windows installer v1.0 of Jarvis on GitHub Releases. This document chooses a
default; it does **not** buy, enroll in, or create any certificate, and it does
not modify the release workflow, Tauri config, scripts, or any source file.

**Scope (fixed by the task):** only four options — SignPath Foundation, Azure
Trusted Signing (Artifact Signing), a standard OV code-signing certificate, and
an EV code-signing certificate. No other route is considered here.

**Research date:** all pages below were opened on **2026-11-02**. Every price,
identity rule, and timing claim carries the page URL and that date. Where a page
could not be opened, or did not publish the figure, the claim is marked
**UNVERIFIED** and no number is invented. The word **UNVERIFIED** appears
throughout, including on rows that are otherwise sourced.

**Existing context (read first, not re-litigated here):**
- `docs/release-signing.md` — the two pipeline routes (signing service vs.
  classic certificate) and the wiring steps.
- `README.md` — "Release" / "Build" sections.
- `.github/workflows/release.yml` — GitHub-hosted `windows-latest` runner; supports
  a signing-service command (`WINDOWS_SIGNING_COMMAND`) or a base64 PFX
  (`WINDOWS_SIGNING_CERT_PFX_BASE64` + password).

---

## How to read the columns

| Column | Meaning |
|---|---|
| **Who holds the private key** | Whether the key leaves the vendor's HSM or sits with the buyer. |
| **Identity check the vendor requires** | What the vendor verifies before issuing/using a cert. |
| **GitHub-hosted Windows CI can use it** | Whether the existing `windows-latest` workflow can sign without a self-hosted runner or hardware token. |
| **Published time to a first signature** | Vendor-published elapsed time from start to first usable signature. |
| **SmartScreen reputation (vendor statement)** | What the vendor publishes about Windows SmartScreen behaviour. |
| **Price (vendor's own page)** | As published by the vendor, with URL + date. |

---

## At a glance

| Option | Private key held by | Vendor identity check | GitHub-hosted Windows CI | Published time to first signature | SmartScreen (vendor statement) | Price (vendor page) |
|---|---|---|---|---|---|---|
| SignPath Foundation | SignPath (HSM) | Project reputation/control; no personal ID (MFA + roles required) | Yes, but all workflow jobs must run on GitHub-hosted runners (OSS) | UNVERIFIED (no published SLA) | UNVERIFIED (no SignPath-specific SmartScreen claim found) | Free ($0) for OSI-approved OSS — signpath.org, opened 2026-11-02 |
| Azure Trusted Signing (Artifact Signing) | Microsoft (FIPS 140-3 L3 HSM) | Govt-issued ID via AU10TIX for individuals; business registration + email for orgs | Yes, via `azure/artifact-signing-action` / SignTool + dlib | 1–20 business days for org identity validation (published); individual time UNVERIFIED | Reputation accumulates over time based on download volume and behaviour (Microsoft) | $9.99/mo Basic (5,000 sigs), $99.99/mo Premium (100,000) — stated on Microsoft Learn, opened 2026-11-02; Azure pricing page rendered "$-" (UNVERIFIED) |
| Standard OV code-signing cert | Buyer (PFX / token) | Org validation (CA/B Forum); vendor-specific steps UNVERIFIED | Yes as a PFX in secrets via `signtool` | UNVERIFIED (not published on the page opened) | UNVERIFIED as a vendor claim; Microsoft states warning until reputation accumulates | $44/mo ($696/12-mo) — DigiCert code-signing page, opened 2026-11-02 |
| EV code-signing cert | Buyer (hardware token / HSM) | Stricter org + individual validation; vendor-specific steps UNVERIFIED | Not as a classic token; only via a CA cloud/HSM signing service (UNVERIFIED) | UNVERIFIED (not published on the page opened) | UNVERIFIED as a vendor claim; Microsoft states EV no longer bypasses SmartScreen | $62/mo ($972/12-mo) — DigiCert code-signing page, opened 2026-11-02 |

---

## 1. SignPath Foundation

**Who holds the private key:** SignPath holds it in an HSM. The certificate is
issued to *SignPath Foundation*, not to the maintainer; SignPath Foundation is the
publisher of record. (Source: https://signpath.org/ , opened 2026-11-02;
https://signpath.org/terms , opened 2026-11-02.)

**Identity check the vendor requires:** no personal government ID. SignPath
verifies **project reputation and control** — that the binary is an automated
build from the project's own source repository. Conditions include: OSI-approved
open-source licence with no commercial dual-licensing, no proprietary components,
active maintenance, the project must **already be released in the form that
should be signed**, documented download page, MFA for all team members on both
SignPath and the source repository, self-organised author/reviewer/approver roles,
and a **code signing policy** published on the project's home page (this repo
already has `docs/code-signing-policy.md`). (Source: https://signpath.org/terms ,
opened 2026-11-02.)

**GitHub-hosted Windows CI can use it:** **Yes, with a constraint.** SignPath
provides a `submit-signing-request` GitHub Action
(`signpath/github-action-submit-signing-request`) and the GitHub connector
performs origin verification. For OSS projects, **all jobs of the workflow leading
up to the signing request must run on GitHub-hosted runners**. (Source:
https://docs.signpath.io/trusted-build-systems/github , opened 2026-11-02.)

**Published time to a first signature:** **UNVERIFIED.** No application-review
SLA or turnaround time is published on the pages opened. (Pages opened:
https://signpath.org/apply and https://signpath.org/terms , 2026-11-02.)

**SmartScreen reputation (vendor statement):** **UNVERIFIED.** SignPath publishes
no SmartScreen-specific claim on the pages opened. Microsoft's general
SmartScreen rules still apply to any Authenticode signature: a new file shows a
warning until its hash (and publisher) accumulates download history, and there is
no exact threshold (see https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation , opened 2026-11-02).

**Price (vendor's own page):** **Free ($0)** for qualifying OSI-approved open
source projects. (Source: https://signpath.org/ , opened 2026-11-02; terms at
https://signpath.org/terms , opened 2026-11-02.)

**Caveats worth knowing (from `docs/release-signing.md`):** SignPath requires
the project to already be released in the form to be signed, so the very first
v1.0 may have to ship unsigned (or via another route) and SignPath signs later
releases. Every release needs **manual approval** for signing, and file-metadata
restrictions (consistent product name/version attributes) are enforced.

---

## 2. Azure Trusted Signing (Artifact Signing)

**Who holds the private key:** Microsoft, inside FIPS 140-3 Level 3 HSMs. The
Authenticode certificate is never handed to you; only the public certificate
appears in signed binaries. (Source: https://learn.microsoft.com/en-us/azure/trusted-signing/faq ,
opened 2026-11-02.)

**Identity check the vendor requires:**
- **Individual (Ethan's likely route):** the Azure billing account must be of
  type **Individual**, the account holder must be in the **United States or
  Canada**, and the legal name and sold-to address on the billing account must
  match a **government-issued ID** (passport, driver's licence, state ID)
  verified through Microsoft's Verified ID flow using a trusted partner
  (AU10TIX), via the Microsoft Authenticator app. (Source:
  https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart , opened
  2026-11-02.)
- **Organization:** legal business entity name, website on a domain owned by the
  entity, two monitored email addresses on that domain, business identifier,
  business address, plus an individual who performs individual identity
  validation with a government-issued ID. Public records for the entity should be
  current. (Source: same quickstart page, opened 2026-11-02.)
- A paid Azure subscription is required; **free, trial, or sponsored
  subscriptions are not supported.** (Source:
  https://learn.microsoft.com/en-us/azure/trusted-signing/faq , opened
  2026-11-02.)

**GitHub-hosted Windows CI can use it:** **Yes.** Microsoft lists GitHub Actions
as a supported integration (`azure/artifact-signing-action`), plus SignTool with
the Artifact Signing dlib, and the client tools install via `winget` on a
Windows runner. (Source:
https://learn.microsoft.com/en-us/azure/trusted-signing/how-to-signing-integrations ,
opened 2026-11-02.)

**Published time to a first signature:** **1 to 20 business days** for
**organization** public identity validation (processing time published on the
quickstart page). For **individual** identity validation, no processing-time
figure is published — **UNVERIFIED**. (Source:
https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart , opened
2026-11-02.)

**SmartScreen reputation (vendor statement):** Microsoft states reputation
**accumulates over time based on download volume and behaviour**; the prompt
stops once the file hash has sufficient download history. Artifact Signing does
**not** issue EV certificates, and does not grant instant SmartScreen
reputation. (Source:
https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ,
opened 2026-11-02; FAQ at
https://learn.microsoft.com/en-us/azure/trusted-signing/faq , opened 2026-11-02.)

**Price (vendor's own page):** **$9.99/month (Basic, 5,000 signatures) and
$99.99/month (Premium, 100,000 signatures)**, with $0.005 per additional
signature on Basic — stated on the Microsoft Learn SmartScreen-reputation page
(https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ,
opened 2026-11-02) and in `docs/release-signing.md`. The Azure pricing page
itself (https://azure.microsoft.com/en-us/pricing/details/artifact-signing/ ,
opened 2026-11-02) rendered the base price as "$-" in the static HTML fetched,
so the numeric price on that specific page is **UNVERIFIED** as fetched; the
figure above is taken from the Microsoft Learn page cited. Billing is not
pro-rated; the full SKU amount is charged from account creation. (Source:
https://learn.microsoft.com/en-us/azure/trusted-signing/faq , opened 2026-11-02.)

---

## 3. Standard OV code-signing certificate

**Who holds the private key:** the buyer, in a `.pfx` (or on a token/HSM if
chosen). The workflow already supports this route via
`JARVIS_SIGNING_PFX_PATH` + `JARVIS_SIGNING_PFX_PASSWORD` or
`JARVIS_SIGNING_THUMBPRINT`. (Source: `docs/release-signing.md`, opened
2026-11-02; `.github/workflows/release.yml`, opened 2026-11-02.)

**Identity check the vendor requires:** OV requires organisation validation under
the CA/Browser Forum Code Signing Baseline Requirements. The specific steps,
documents, and turnaround for the CA whose price is quoted below (DigiCert) are
**not** published on the page opened — **UNVERIFIED**. (Page opened:
https://www.digicert.com/signing/code-signing-certificates , 2026-11-02.)

**GitHub-hosted Windows CI can use it:** **Yes**, as a PFX stored in repository
secrets, signed with `signtool` (SHA-256, RFC 3161 timestamp) — exactly what
the existing workflow's "Stage the signing credential" step does. (Source:
`.github/workflows/release.yml`, opened 2026-11-02.)

**Published time to a first signature:** **UNVERIFIED** — no issuance SLA is
published on the page opened. (Page opened:
https://www.digicert.com/signing/code-signing-certificates , 2026-11-02.)

**SmartScreen reputation (vendor statement):** **UNVERIFIED** as a DigiCert claim
— no SmartScreen-specific statement was found on the page opened. Microsoft
states that a file signed with a valid (OV or EV) certificate still shows a
SmartScreen "unrecognized" warning until reputation accumulates; the verified
publisher name is displayed. (Source:
https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ,
opened 2026-11-02.)

**Price (vendor's own page):** **$44/month per certificate** ($696 for a
12-month auto-renewing subscription), as published on the DigiCert code-signing
page (https://www.digicert.com/signing/code-signing-certificates , opened
2026-11-02). The page also offers storage variants (DigiCert KeyLocker cloud,
hardware token, own token, HSM); the quoted price is the "starting at" figure
shown and the storage variant it applies to is not disambiguated on the page as
fetched — treat as **UNVERIFIED** which variant. Prices subject to change; auto-renews
every 12 months until cancelled.

---

## 4. EV code-signing certificate

**Who holds the private key:** the buyer, on a hardware token or HSM supplied by
the CA (DigiCert's page offers DigiCert-issued hardware token, own qualified
token, or HSM). The key does not leave the token. (Source:
https://www.digicert.com/signing/code-signing-certificates , opened 2026-11-02.)

**Identity check the vendor requires:** stricter than OV — extended validation of
the legal entity plus individual identity, and (for DigiCert) hardware-token
delivery. Vendor-specific steps and documents for the quoted CA are **not**
published on the page opened — **UNVERIFIED**. (Page opened:
https://www.digicert.com/signing/code-signing-certificates , 2026-11-02.)

**GitHub-hosted Windows CI can use it:** **Not as a classic token on a
GitHub-hosted runner** — a USB/HSM token cannot be attached to `windows-latest`.
It becomes usable only if the CA's cloud/HSM signing service (e.g. DigiCert
KeyLocker) is used, which is effectively a signing-service route rather than a
classic EV cert, and its GitHub Actions support is **UNVERIFIED** on the pages
opened. (DigiCert page opened 2026-11-02; workflow behaviour from
`.github/workflows/release.yml`, opened 2026-11-02.)

**Published time to a first signature:** **UNVERIFIED** — no issuance SLA is
published on the page opened. (Page opened:
https://www.digicert.com/signing/code-signing-certificates , 2026-11-02.)

**SmartScreen reputation (vendor statement):** **UNVERIFIED** as a DigiCert
claim. Critically, **Microsoft states that EV certificates no longer bypass
SmartScreen** — years ago an EV cert granted positive reputation by default, but
that behaviour no longer exists, and paying a premium for EV solely to avoid
SmartScreen warnings is no longer justified. (Source:
https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ,
opened 2026-11-02.)

**Price (vendor's own page):** **$62/month per certificate** ($972 for a
12-month auto-renewing subscription), as published on the DigiCert code-signing
page (https://www.digicert.com/signing/code-signing-certificates , opened
2026-11-02). Same storage-variant caveat as the OV row above (UNVERIFIED which
variant the price applies to).

---

## Recommendation

**Recommended default: Azure Trusted Signing (Artifact Signing).**

Reasons:
1. It is the only option that is both **usable from the existing GitHub-hosted
   `windows-latest` workflow without a hardware token** and **does not place a
   long-lived private key in repository secrets** — the two properties the
   existing pipeline and `docs/release-signing.md` are built around.
2. At $9.99/month for 5,000 signatures it is cheaper than a classic OV cert
   ($44/month on the DigiCert page opened) and far cheaper than EV ($62/month),
   while SmartScreen behaviour is the same class as OV/EV (reputation
   accumulates over time; EV no longer buys an advantage).
3. It is available to an individual developer (Ethan), whereas SignPath's free
   route requires the project to already be released in the form to be signed —
   which would force the first v1.0 to ship unsigned or wait. SignPath remains
   the better **long-term** answer for a public open-source project and its
   application can be started in parallel, but it cannot be the route that ships
   the first signed v1.0 today.
4. EV's historical SmartScreen advantage is gone (Microsoft), so its higher
   price and hardware-token friction buy nothing for this use case.

This recommendation is a **proposal for the owner to accept or reject**. It is
**not** marked as purchased, approved, enrolled, or in progress.

---

## What Ethan would still have to do himself

Identity, payment, and secret custody are operator-gated and cannot be done by an
agent:

1. **Payment / subscription.** Create a **paid** Azure subscription (free,
   trial, or sponsored subscriptions are not supported for Artifact Signing) and
   accept the $9.99/month (or $99.99/month Premium) charge. No certificate is
   purchased; this is a service subscription.
2. **Identity (individual route).** Ensure the Azure billing account is of type
   **Individual** and that the account holder is in the **US or Canada**; make
   the legal name and sold-to address match a government-issued ID; complete the
   AU10TIX Verified ID flow in Microsoft Authenticator. Plan for the identity
   validation to take an unpublished (UNVERIFIED) amount of time for the
   individual route.
3. **Azure setup.** Register the `Microsoft.CodeSigning` resource provider,
   create an Artifact Signing account, create an identity validation, create a
   **Public Trust** certificate profile (a Private Trust profile produces a
   signature Windows will not trust), and assign the Artifact Signing Identity
   Verifier and Certificate Profile Signer roles.
4. **Secret custody / wiring (no cert stored in the repo).** Set the repository
   **variable** `WINDOWS_SIGNING_COMMAND` to the signing command, plus the
   matching **secrets** it needs (endpoint and credentials). Do **not** commit a
   certificate, password, thumbprint, or any secret to the tree. The private key
   never leaves Azure.
5. **Validation.** Run the workflow by hand with `draft=true` and
   `allow_unsigned=true` to prove the path, then create the `v1.0.0` tag.

## What this document does not claim

- No certificate, identity validation, or subscription has been created or
  approved by this document.
- No SmartScreen reputation has been measured; all SmartScreen statements above
  are the vendors' (or Microsoft's) published positions, cited with URLs and
  dates.
- Any row marked **UNVERIFIED** means the page could not be opened or did not
  publish the figure; no number has been invented for it.