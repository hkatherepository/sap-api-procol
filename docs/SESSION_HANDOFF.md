# Session Handoff — SAP Integration

Updated: 2026-08-06

## Security boundary

- Do not read or print `.env`, private keys, passwords, tokens, or runtime credentials.
- The local SSH private key is expected at `secrets/id_ed25519`; never display or copy it to the SSH server.
- Only non-secret status/error output may be requested from the user.

## SSH database tunnel status

- A `db-tunnel` Compose sidecar has been implemented with strict host checking, public-key-only authentication, a read-only filesystem, dropped capabilities, tmpfs key copy, and no published host port.
- The SSH key pair was generated on the MacBook.
- The restricted public key was successfully installed for `fariz@38.47.88.75`.
- The SSH host fingerprint from the server and MacBook matched:
  `SHA256:eCRpTgM73QeJ3CeNtI4TqEWVTqlN+nbeKEs4UetOXPk`.
- `secrets/known_hosts` was created from the verified candidate.
- `docker compose port db-tunnel 15432` returned no published mapping, which is expected.
- A final `db-tunnel` health result was not provided in the conversation; do not assume it is healthy without checking.

## SAP VPN/network findings

- The MacBook routes `10.30.68.21/32` through VPN interface `utun5`.
- ICMP to `10.30.68.21` succeeded.
- TCP `10.30.68.21:9935` succeeded after one earlier transient refusal.
- A Docker Alpine container also reached `10.30.68.21:9935` successfully, so Docker-to-VPN routing works.

## SAP TLS findings

- Postman succeeds because global SSL certificate verification is disabled.
- macOS `curl` failed with `self signed certificate`.
- Node.js in Docker failed with `DEPTH_ZERO_SELF_SIGNED_CERT`.
- The public certificate presented by the endpoint was saved locally as `secrets/sap-ca.crt` by the user. Do not inspect its contents.
- User-provided public certificate metadata:
  - Subject and issuer: `C=DE, O=SAP Trust Community, OU=SAP Web AS, OU=I0021057724, CN=*.hutamakarya.com`
  - Valid from 2018-03-14 through 2038-01-01
  - SHA-256 fingerprint: `B3:DF:E6:E3:35:8B:B9:F9:F7:10:2D:01:CB:17:FE:6A:4A:26:47:3B:2B:F6:56:C9:AD:30:43:04:8E:6D:BB:4C`
  - No Subject Alternative Name extension
- `curl --cacert secrets/sap-ca.crt https://10.30.68.21:9935/...` passed certificate trust but failed hostname validation because the URL uses an IP while the certificate CN is `*.hutamakarya.com`.
- Reverse DNS for `10.30.68.21` returned NXDOMAIN.

## Last attempted test

The user ran a test using the guessed placeholder hostname `sap-api.hutamakarya.com` with `curl --resolve`, but did not provide the command result. This hostname is not confirmed as official and must not be placed in runtime configuration based only on the guess.

## Current temporary decision

The user accepted a temporary application-scoped exception that matches Postman behavior: `SAP_TLS_REJECT_UNAUTHORIZED=false`. The CA mount and certificate preparation remain in place, the service emits a warning, and the exception is documented in `docs/SAP_TLS_IMPROVEMENT.md`. This supersedes the earlier instruction below while the design is discussed with a senior developer.

## Target secure decision

Choose one of these secure paths:

1. Obtain the official SAP API hostname matching `*.hutamakarya.com`, test it with `curl --resolve`, and use that hostname in all SAP URLs.
2. If no official hostname exists, implement explicit SHA-256 certificate fingerprint pinning for the IP endpoint. This must remain fail-closed and must not use `rejectUnauthorized=false` globally.
3. Ask the endpoint owner to issue a modern certificate containing the official hostname or IP in Subject Alternative Name.

Do not use the process-global `NODE_TLS_REJECT_UNAUTHORIZED=0`. The current application-scoped `rejectUnauthorized=false` is a recorded temporary risk acceptance, not the production security target.
