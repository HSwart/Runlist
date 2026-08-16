---
name: publish-runlist
description: Safely publish a reviewed Runlist VSIX to the Visual Studio Marketplace with Microsoft Entra authentication. Use for Runlist Marketplace publishing, releasing, uploading, or checking whether the package is ready to publish. Do not use for ordinary development, testing, or packaging requests that do not include Marketplace publication.
---

# Publish Runlist

Publish only the exact VSIX that was reviewed and tested. Use the repository's guarded npm command; do not improvise another publishing path.

## Workflow

1. Work from the Runlist repository root and read `AGENTS.md` plus `docs/marketplace-release.md`.
2. Confirm the user explicitly asked to publish. If they asked only to prepare, test, or package a release, do not publish it.
3. Run `git status --short --branch`. Publish only from a clean `main` working tree. Stop and report any other branch or uncommitted changes.
4. Read `package.json` and confirm the intended Marketplace version. Do not change the version, changelog, release, or VSIX unless the user explicitly requested that work.
5. Run `az account show` to confirm Microsoft Entra authentication. If it fails, ask the user to complete `az login --allow-no-subscriptions`. Never request, create, store, or use a Personal Access Token.
6. Run `npm test`.
7. Run `npm run validate:marketplace:publish` and `npm run validate:marketplace:vsix`. If either fails, stop. Do not publish or silently rebuild the package.
8. Re-check the repository instructions. If they permit the agent to publish and the user explicitly authorized it, publish the reviewed artifact with exactly:

   ```bash
   npm run publish:marketplace
   ```

   If repository policy forbids agent publication, do not run the command; give the user this exact command as the final handoff.
9. Report the published extension version and command result when publication ran. Do not claim publication succeeded unless the command confirms it.

## Guardrails

- Do not run `npx vsce publish`, raw `vsce publish`, or a Marketplace portal upload.
- Do not run `npm run package` during the publish step because it overwrites the reviewed VSIX. Package preparation is a separate, explicitly requested step.
- Do not add credentials, tenant data, CLI login state, `.env` files, or secrets to the repository.
- Do not bypass a stale-VSIX, metadata, test, authentication, branch, or dirty-tree failure.
- Do not republish an existing Marketplace version.
