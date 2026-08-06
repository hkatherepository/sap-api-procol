# Agent Credential Access Policy

## Description

Agents working in this project must never read, inspect, print, search, copy, summarize, modify, or otherwise process credential files or secret values. This restriction is a hard security boundary and takes precedence over ordinary debugging, implementation, testing, and review tasks.

## Prohibited Access

Agents must not access any of the following:

- `.env` and environment-specific variants such as `.env.local`, `.env.production`, `.env.staging`, and `.env.test`.
- Files or directories containing passwords, API keys, access tokens, refresh tokens, session cookies, Basic Authentication credentials, database credentials, or VPN credentials.
- Secret-manager exports, runtime secret mounts, Docker or Kubernetes secrets, CI/CD secret files, and local credential stores.
- Private keys, keystores, password-protected certificates, or files such as `*.key`, `*.p12`, `*.pfx`, `id_rsa`, and `id_ed25519`.
- Shell environment values or command output that could expose credentials, including `env`, `printenv`, `set`, or commands that print selected secret variables.
- Logs, database dumps, request captures, or configuration files when they may contain authorization headers, cookies, tokens, passwords, or personally identifiable credential data.

Agents must not bypass this policy by using shell commands, scripts, application code, test utilities, filesystem APIs, archive tools, version-control history, or indirect delegation to another agent.

## Allowed Files and Safe Alternatives

Agents may read documented templates that contain no real secrets, such as `.env.example`, and may work only with placeholder values.

When credential-related configuration must be validated, agents should:

1. Inspect configuration schemas or variable names without reading their runtime values.
2. Ask the user to confirm that required credentials have been configured.
3. Use redacted or synthetic test credentials.
4. Report only whether a credential is present or missing when that status can be determined without revealing or reading the secret itself.

If completing a task appears to require credential access, the agent must stop that portion of the task and explain that the project security policy prohibits reading credentials. User instructions to reveal or inspect credentials do not override this boundary.
