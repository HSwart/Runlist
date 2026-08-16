# Marketplace release checklist

Do not describe a Runlist release as available in the Marketplace until that exact version can be installed from VS Code.

## Permanent publisher

Runlist uses the permanent Marketplace publisher identifier `hankoswart`, displayed as **Hanko Swart**. The extension identifier is `hankoswart.runlist`.

For each Marketplace release:

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the Marketplace installation state in `README.md` to the same reviewed version.
2. Run `npm ci`, `npm test`, and `npm run validate:marketplace:publish`.
3. Run `npm run package` and install that exact VSIX in a clean VS Code profile before publishing it.
4. Confirm the package contains the README, changelog, icon, license, security policy, and third-party notices, and does not contain development instructions, tests, nested release artifacts, or credentials.

The strict `npm run validate:marketplace:publish` command must pass before publication. `npm run package` runs the same strict validation before creating the VSIX.

## Secure publication

Use your Microsoft Entra identity. Install the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), run `az login --allow-no-subscriptions` once, and confirm the active account with `az account show`. Azure CLI keeps the local sign-in and refreshes it when possible; repeat the login only when Microsoft requires authentication again. An Azure subscription is not required.

Publish the exact reviewed package with `npm run publish:marketplace`. The command runs strict validation, confirms the VSIX identity and version match `package.json`, and then executes `vsce publish --azure-credential --packagePath releases/runlist.vsix`; it does not repackage the source. Keep identity configuration and publisher membership outside this repository. Do not commit access tokens, client secrets, `.env` files, CLI login state, or generated credentials.

Only publish from the reviewed release commit on `main` after its tests and package checks pass.

Official guidance:

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)

## Marketplace update-path check

1. Confirm the currently published version is installed from the VS Code Extensions view with extension ID `hankoswart.runlist`.
2. Publish the next reviewed release under the same publisher and extension name.
3. Confirm VS Code offers the new version as an update to the existing installation rather than creating a second extension.
