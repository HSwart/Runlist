# Marketplace release checklist

Switchboard is prepared for the VS Code Marketplace, but it is not published there yet. Do not describe it as available in the Marketplace until the listing can be installed from VS Code.

## Maintainer decision: permanent publisher

The maintainer must choose or select the permanent Visual Studio Marketplace publisher identifier. Microsoft does not allow that identifier to be renamed later, so this repository deliberately keeps `publisher: local` until the decision is made.

After the real publisher exists:

1. Replace `local` in `package.json` with the exact publisher identifier.
2. Choose the reviewed release version after `0.0.1`, update `package.json` and `package-lock.json`, and move the `Unreleased` changelog notes under that version.
3. Add the official Marketplace listing URL and publisher name to the installation section in `README.md`.
4. Run `npm ci`, `npm test`, and `npm run validate:marketplace:publish`.
5. Run `npm run package` and install that exact VSIX in a clean VS Code profile before publishing it.
6. Confirm the package contains the README, changelog, icon, license, security policy, and third-party notices, and does not contain development instructions, tests, nested release artifacts, or credentials.

The preparation validator, `npm run validate:marketplace`, checks all metadata while allowing the unresolved publisher with a warning. The stricter `npm run validate:marketplace:publish` command must pass before publication.

## Secure publication

Use Microsoft Entra ID workload identity federation or a managed identity. Publish the exact reviewed package with `vsce publish --azure-credential --packagePath releases/switchboard.vsix`; do not use a publish command that repackages the source. Keep tenant configuration and publisher membership outside this repository. Do not commit access tokens, client secrets, `.env` files, CLI login state, or generated credentials.

Only publish from the reviewed release commit after its tests and package checks pass. The publishing job should be limited to protected release tags and the selected Marketplace publisher.

Official guidance:

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)

## First listing and update-path check

1. Publish the reviewed first listing under the permanent publisher.
2. Install it from the VS Code Extensions view and confirm the installed extension ID is `<publisher>.switchboard`.
3. Keep the GitHub release available as the manual VSIX fallback.
4. For a later reviewed release, update the version, changelog, Marketplace package, and GitHub release artifact together.
5. Install that later release through the Marketplace and confirm VS Code updates the existing installation rather than creating a second extension.

Version changes, Marketplace publication, GitHub release replacement, and publisher creation are intentionally outside this preparation change.
