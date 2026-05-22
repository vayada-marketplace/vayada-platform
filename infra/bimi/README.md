# BIMI — Sender avatar for `noreply@vayada.com`

BIMI (Brand Indicators for Message Identification) lets supporting mail clients render the Vayada V as the sender avatar for mail from `vayada.com`, replacing the generic gray silhouette.

## What this directory ships

- `vayada-bimi.svg` — the brand mark in the BIMI-mandated SVG profile (SVG Tiny 1.2 PS, `baseProfile="tiny-ps"`, square 1:1 viewBox, `<title>` element, no scripts, no external refs).
- Hosting: uploaded to `s3://vayada-uploads-prod/branding/vayada-bimi.svg` via `infra/s3.tf` (`aws_s3_object.bimi_logo`). Public URL: `https://vayada-uploads-prod.s3.eu-west-1.amazonaws.com/branding/vayada-bimi.svg`.
- DNS: `default._bimi.vayada.com` TXT record in `infra/route53.tf` (`aws_route53_record.bimi`).

> The SVG is currently a hand-traced approximation of the V mark from `vayada-logo.png`. Drop in the design team's master vector when available — re-export to SVG Tiny PS profile and run through the validator below.

## Prerequisites that must already be true in DNS

BIMI does nothing without these. Verify before relying on the rollout:

1. **DMARC enforcement** at `_dmarc.vayada.com`: policy must be `p=quarantine` or `p=reject`, with `pct=100` (or no `pct` tag). `p=none` is not enough.
2. **SPF and DKIM** aligned for `vayada.com` so the SES envelope passes DMARC.

Quick check:

```bash
dig +short TXT _dmarc.vayada.com
dig +short TXT default._bimi.vayada.com
```

If DMARC is at `p=none`, fix that first; BIMI publishing without DMARC enforcement is a no-op (and will fail the validator).

## What works without a certificate

Once the DNS record propagates, the avatar will render in:

- Apple Mail / iCloud Mail
- Yahoo Mail
- Fastmail
- La Poste, Onet, and other BIMI-compliant clients

## Gmail requires a certificate

Gmail (the client in the screenshot on the originating ticket) does **not** display BIMI logos without a Verified Mark Certificate (VMC) or Common Mark Certificate (CMC):

- **VMC** — issued by Entrust or DigiCert, ~$1k–$1.5k/year, requires a registered trademark on the V mark. Adds the blue "verified" checkmark in Gmail.
- **CMC** — Gmail-supported alternative, no trademark requirement, cheaper. No "verified" badge.

When a certificate is procured, append the `a=` tag to the BIMI TXT record:

```
v=BIMI1; l=https://vayada-uploads-prod.s3.eu-west-1.amazonaws.com/branding/vayada-bimi.svg; a=https://<host>/<vmc-or-cmc>.pem;
```

(Edit the `records` list in `infra/route53.tf`.)

## Validation

After `terraform apply`:

```bash
dig +short TXT default._bimi.vayada.com
curl -I https://vayada-uploads-prod.s3.eu-west-1.amazonaws.com/branding/vayada-bimi.svg
```

Then run the published record + SVG through:

- https://bimigroup.org/bimi-generator/ (validator mode)
- https://mxtoolbox.com/bimi.aspx

End-to-end test: send a real email from `noreply@vayada.com` to a known iCloud or Yahoo inbox and check the avatar.
