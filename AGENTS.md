# Agent Instructions

## Development

- Use Node.js from `.nvmrc`.
- Use the root npm scripts for tests, typechecking, package checks, and Git-install verification.
- Keep `package.json#files` as an exact runtime allowlist. Do not package tests, local router configuration, usage data, or development scripts.
- Treat `model-tier-router.json` and `.pi/model-tier-router.json` as local policy; never commit them.

## Completion

- Run `npm run check` and `npm run verify:git-install` before completing package changes.
- Stage explicit paths and commit locally. Never push, tag, or publish without explicit approval immediately beforehand.
