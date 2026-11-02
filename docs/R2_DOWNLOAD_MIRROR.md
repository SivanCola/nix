# R2 release download mirror

Public downloads use <https://downloads.deepzora.app/>. GitHub remains the
canonical release source and the fallback shown beside every installer. Desktop
automatic updates and Homebrew continue to use the existing GitHub URLs.

## Configuration

The `deepzora-releases` R2 bucket uses Standard storage, a custom domain with
minimum TLS 1.2, and Smart Tiered Cache. Versioned paths under
`/desktop/desktop-vVERSION/` and `/cli/vVERSION/` have a one-month edge TTL.
Responses with status 400 or higher are not stored. `latest.json` bypasses cache.
The download index uses a 60-second browser/cache TTL and never moves backwards
when an older release is recovered.
An exact-path redirect sends `https://downloads.deepzora.app/` to
`https://downloads.deepzora.app/index.html`; R2 does not automatically serve an
index document for the bucket root.

GitHub Actions repository secrets:

- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: an R2 account token restricted to
  **Object Read & Write** on `deepzora-releases` only.
- `R2_ACCOUNT_ID`: the Cloudflare account containing that bucket.
- `R2_BUCKET`: `deepzora-releases`.

Repository variables:

- `R2_PUBLIC_BASE`: `https://downloads.deepzora.app`.
- `ENABLE_R2_DOWNLOADS`: `true` to enable the new download mirror. This is separate
  from the historical `ENABLE_R2_MIRROR` metadata integration.

The workflow needs only GitHub `contents: read`; the R2 token has no bucket
administration, DNS, or other Cloudflare permissions. Keep credentials in Actions
Secrets, never in source or workflow artifacts.

## Automatic publication and recovery

`Publish release candidate` calls `Sync release downloads to R2` after the public
release postflight succeeds. Mirror failure is visible as a failed job and can be
retried independently without republishing CLI, npm, Desktop, or release pointers:

```sh
gh workflow run release-mirror.yml --repo SivanCola/deepzora --ref main -f version=0.0.2
```

The manual workflow accepts an already-published stable version and runs only
from protected `main`. Both CLI and Desktop tags must identify the same commit.
The script validates the complete Desktop matrix against `latest.json`, CLI
archives against `SHA256SUMS`, and every source file against its GitHub release
SHA-256 digest before writing any objects. Signatures are copied byte for byte.

Every object is downloaded through the public CDN and hashed again. Existing
versioned objects must match size and SHA-256 metadata; conditional S3 writes
prevent concurrent runs from overwriting them. Failed uploads leave the download
index unchanged. Retry fills missing objects and verifies existing ones.

The mirror contains:

- `desktop/desktop-vVERSION/`: installers, updater archives, their `.minisig`
  signatures, the unchanged `latest.json`, generated `SHA256SUMS`, `mirror.json`,
  and a versioned `index.html`.
- `cli/vVERSION/`: six native CLI archives and the official `SHA256SUMS`.
- `index.html`: a download page advanced only after all versioned files pass
  public readback. Its links identify immutable versions.

The workflow saves `r2-mirror-report.json` as a 90-day Actions artifact. The report
records the source SHA and public URL, size, and SHA-256 of every verified object.

## Local backfill

Install Node from `.node-version`, GitHub CLI, curl, and AWS CLI `1.46.2`.
Authenticate GitHub CLI and provide R2 S3 credentials using the process environment:
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION=auto`,
`AWS_REQUEST_CHECKSUM_CALCULATION=when_required`, and
`AWS_RESPONSE_CHECKSUM_VALIDATION=when_required`, along with the R2 settings above.

```sh
R2_MIRROR_WORKDIR=/tmp/deepzora-release-mirror \
R2_MIRROR_REPORT=/tmp/deepzora-mirror-report.json \
  node scripts/release-r2-mirror.mjs 0.0.2
```

An explicit work directory retains source files for resumable backfill. Remove it
after acceptance. Without one, the script creates and cleans its own temporary
directory. S3 uploads use `If-None-Match: *` and `Content-MD5`; the current 307 MB
largest package fits comfortably below the S3 single-PUT 5 GiB limit. Cloudflare
Free/Pro/Business caches files up to 512 MB; larger packages remain downloadable
from R2 but need a different caching arrangement.

## Acceptance

Check the mirror inventory, compare public SHA-256 values with the official
release, request a package twice to observe `CF-Cache-Status: HIT`, and confirm a
byte-range request returns `206 Partial Content`. A cache hit confirms CDN
delivery; download speed for a particular country or ISP still requires a test
from that network.
