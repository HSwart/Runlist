# Marketplace release checklist

Do not describe a Runlist release as available in the Marketplace until that exact version can be installed from VS Code.

## Permanent publisher

Runlist uses the permanent Marketplace publisher identifier `hankoswart`, displayed as **Hanko Swart**. The extension identifier is `hankoswart.runlist`.

For each Marketplace release:

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the Marketplace installation state in `README.md` to the same reviewed version.
2. Run `npm ci` and `npm test`, run the extension-host smoke gate below, and then run `npm run validate:marketplace:publish`.
3. Run `npm run package` and install that exact VSIX in a clean VS Code profile before publishing it.
4. Confirm the package contains the README, changelog, icon, license, security policy, and third-party notices, and does not contain development instructions, tests, nested release artifacts, or credentials.

The extension-host smoke gate must pass before package and installation checks. On Windows and macOS, run `npm run test:smoke` in a supported native desktop session. On Linux, run `xvfb-run -a npm run test:smoke` with an Xvfb display. This matches the CI workflow. CI completes all three platform results when one fails, and bounds each platform job to 20 minutes. The gate passes only when the command exits successfully and reports `Runlist extension-host smoke suite passed.`

The strict `npm run validate:marketplace:publish` command must pass before publication. `npm run package` runs the same strict validation before creating the VSIX.

Before publication, `npm run validate:marketplace:vsix` checks the tracked `releases/runlist.vsix` artifact. It creates a temporary candidate from the current source, compares the candidate's identity, version, and packaged contents with the tracked artifact, and removes the candidate after the check. The temporary candidate is for comparison only; it is not published or retained.

## Secure publication

Ops publishes from GitHub Actions on `main`. That is the only Ops publish path. Local `vsce` is not required for Ops.

The **Publish Marketplace** workflow uses the `marketplace` GitHub Environment and its `VSCE_PAT` secret. The publish job sets `environment: marketplace` so GitHub injects that environment secret. Do not print, echo, or commit the token.

How Ops publishes after the reviewed release is on `main` and its tests have passed:

GitHub → Actions → **Publish Marketplace** → **Run workflow**, with the `main` branch selected (`workflow_dispatch`).

The workflow runs `npm ci`, then `npm run package` (strict Marketplace validation and a fresh `releases/runlist.vsix`), then `@vscode/vsce publish --packagePath releases/runlist.vsix` with `VSCE_PAT` from the environment. It does not run `npm run publish:marketplace` and does not pass `--azure-credential`.

The `marketplace` environment is limited to protected branches. `main` is protected, so `workflow_dispatch` on `main` can use the environment. Publishing from a tag is not supported until that environment also allows tags. Do not change environment protection rules from this repository.

Open VSX is not part of this workflow.

### Local Microsoft Entra (optional Hanko fallback)

This is not a second Ops route. Keep `npm run publish:marketplace` for Hanko only, when GitHub Actions is unavailable and a local Microsoft Entra sign-in is already in place.

Use your Microsoft Entra identity. Install the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), run `az login --allow-no-subscriptions` once, and confirm the active account with `az account show`. Azure CLI keeps the local sign-in and refreshes it when possible; repeat the login only when Microsoft requires authentication again. An Azure subscription is not required.

Run `npm run publish:marketplace`. The command publishes the tracked `releases/runlist.vsix` artifact after, in order, running strict Marketplace metadata validation and VSIX validation with the temporary current-source candidate comparison, then executing `vsce publish --azure-credential --packagePath releases/runlist.vsix`. The temporary candidate is not the artifact published to the Marketplace. Keep identity configuration and publisher membership outside this repository. Do not commit access tokens, client secrets, `.env` files, CLI login state, or generated credentials.

Only publish from the reviewed release commit on `main` after its tests and package checks pass.

Official guidance:

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)

## Marketplace update-path check

1. Confirm the currently published version is installed from the VS Code Extensions view with extension ID `hankoswart.runlist`.
2. Publish the next reviewed release under the same publisher and extension name.
3. Confirm VS Code offers the new version as an update to the existing installation rather than creating a second extension.
