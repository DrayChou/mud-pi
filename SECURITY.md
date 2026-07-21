# Security Policy

## Supported versions

`mud-pi` is currently an early-stage project. Security fixes are applied to the latest commit on `main`; older snapshots and local forks may not receive fixes.

## Reporting a vulnerability

Please do not publish credentials, private save data, access tokens, exploit details, or sensitive AI transcripts in a public Issue.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting or Security Advisory flow for this repository, if available.
2. If private reporting is unavailable, contact the repository maintainer through a private channel listed on the maintainer's GitHub profile.
3. Include the affected commit, reproduction steps, impact, and the smallest safe diagnostic excerpt.
4. Remove API keys, OAuth tokens, cookies, authorization headers, player-identifying data, and unrelated prompt content before sending logs.

A maintainer should acknowledge a valid report before discussing public disclosure. Please allow time for investigation and a coordinated fix.

## Security boundaries

### AI authentication

`mud-pi` relies on the user's local Pi or Codex configuration. The repository does not require API keys in committed files.

- Keep `.env` local.
- Do not commit provider credentials or copied login state.
- Do not paste secrets into player input, world lore, NPC persona text, or bug reports.
- Treat third-party model providers according to their own data-handling policies.

### Saves and diagnostic logs

Files under `saves/` may contain:

- player input;
- generated narration;
- AI system prompts, prompts, and responses;
- persistent Pi Session history;
- world state and story outcomes;
- Web save access tokens;
- stack traces and timing data.

`saves/` is ignored by Git, but users are responsible for storage permissions, backup handling, retention, and deletion. Review and redact files before sharing them.

### Web adapter

The Web adapter creates isolated single-player instances and bearer tokens. It is not a complete public-hosting security layer.

Before exposing it to the Internet, deployers should add:

- HTTPS through a trusted reverse proxy;
- request and session rate limits;
- body-size and concurrency limits;
- idle runtime cleanup;
- disk quotas and log rotation;
- process supervision and health checks;
- an explicit data-retention policy.

Do not treat the save access token as a full user account or enterprise authentication system.

### World scripts

A world pack may load a local `conflict.ts` script. The loader restricts its path to the world-pack directory, but the script still runs as trusted application code.

- Only install world packs from sources you trust.
- Review scripts before running them.
- Do not use the current script mechanism for untrusted public uploads.
- Scripts must not read credentials, spawn unrelated processes, or mutate save files outside the authoritative Engine protocol.

The project does not currently provide a complete Worker or subprocess sandbox for third-party scripts.

### AI output

AI responses are untrusted proposals, not authoritative state. The Engine validates supported operations before commit, but generated text may still be incorrect, offensive, or unsuitable for a particular audience. Operators should choose appropriate providers, models, moderation policies, and world content for their deployment.

## Public issue hygiene

When filing a bug:

- prefer a minimal reproduction using an included example world;
- include Bun version, operating system, backend type, turn, and revision;
- quote only the relevant error lines;
- replace save IDs and tokens with placeholders;
- never attach an entire `saves/` directory without reviewing it first.
