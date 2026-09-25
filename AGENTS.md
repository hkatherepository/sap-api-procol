# Agent Security Rules

These rules apply to every agent working in this repository.

## Secrets and credentials

- Never read, inspect, print, parse, search, summarize, validate, or otherwise access the contents of `.env` or any `.env.*` file, except `.env.example`.
- Never read or inspect any file inside `secrets/`, including private keys, public keys, certificates, and `known_hosts`.
- Never read files that may contain passwords, API keys, access tokens, session cookies, connection strings, private keys, recovery codes, or other credentials.
- Never run commands that dump environment variables or configuration values, including `env`, `printenv`, `set`, or equivalents.
- Never include secret values in commands, logs, patches, test output, responses, or generated documentation.
- Treat values pasted by the user as sensitive. Do not repeat them unless the user explicitly requests that exact value.

## Safe configuration handling

- Use `.env.example` only to understand required variable names and configuration structure.
- Ask the user to verify or change secret-bearing configuration themselves. Refer to variable names and expected formats without reading their current values.
- Diagnostic commands must consume credentials internally without printing them. Prefer reporting only success or failure, but do not use `.env` as an input unless the user explicitly grants permission for that specific command.
- Before running a command that could implicitly load `.env` or files under `secrets/`, explain what it will access and obtain explicit user permission.

## Repository operations

- Exclude `.env`, `.env.*` (except `.env.example`), and `secrets/**` from repository-wide searches.
- Do not add secret-bearing files to Git, patches, archives, build artifacts, or container build contexts.
- If a task cannot be completed without accessing a protected file, stop and ask the user to provide a non-secret, redacted result instead.
