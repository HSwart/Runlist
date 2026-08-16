# Marketplace release checklist

Do not describe a Switchboard release as available in the Marketplace until that exact version can be installed from VS Code.

## Permanent publisher

Switchboard uses the permanent Marketplace publisher identifier `hankoswart`, displayed as **Hanko Swart**. The extension identifier is `hankoswart.switchboard`.

For each Marketplace release:

1. Update `package.json`, `package-lock.json`, `CHANGELOG.md`, and the Marketplace installation state in `README.md` to the same reviewed version.
2. Run `npm ci`, `npm test`, and `npm run validate:marketplace:publish`.
3. Run `npm run package` and install that exact VSIX in a clean VS Code profile before publishing it.
4. Confirm the package contains the README, changelog, icon, license, security policy, and third-party notices, and does not contain development instructions, tests, nested release artifacts, or credentials.

The strict `npm run validate:marketplace:publish` command must pass before publication. `npm run package` runs the same strict validation before creating the VSIX.

## Secure publication

Use Microsoft Entra ID workload identity federation or a managed identity. Publish the exact reviewed package with `vsce publish --azure-credential --packagePath releases/switchboard.vsix`; do not use a publish command that repackages the source. Keep tenant configuration and publisher membership outside this repository. Do not commit access tokens, client secrets, `.env` files, CLI login state, or generated credentials.

Only publish from the reviewed release commit after its tests and package checks pass. The publishing job should be limited to protected release tags and the selected Marketplace publisher.

Official guidance:

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)

## First listing and update-path check

1. Publish reviewed version 0.0.2 under `hankoswart` while its README retains the accurate pre-publication notice and contains no dead install link.
2. Install it from the VS Code Extensions view and confirm the installed extension ID is `hankoswart.switchboard`.
3. Prepare reviewed version 0.0.3 with the live Marketplace link in `README.md`.
4. Publish 0.0.3 and confirm VS Code updates the existing installation rather than creating a second extension.
