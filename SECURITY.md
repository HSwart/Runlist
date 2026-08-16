# Security Policy

Switchboard starts local development projects by running commands saved by the user. It stops the process trees it launched by default and can run an optional custom stop command. We take vulnerabilities that could make this behavior unsafe seriously.

## Supported versions

Security updates are provided for the latest published version of Switchboard.

| Version | Supported |
| --- | --- |
| 0.0.1 | Yes |
| Earlier versions | No |

## Report a vulnerability privately

Please do **not** include security details in a public GitHub issue.

Use **Report a vulnerability** in the repository's **Security** tab to send a private report to the maintainer. If that option is not available, open an issue that only asks for a private contact method. Do not include the vulnerability, project data, credentials, or a proof of concept in that issue.

Include the following in the private report when possible:

- The affected Switchboard version, operating system, and VS Code version.
- What an attacker could do and what access they would need.
- Clear reproduction steps using a harmless test project.
- A minimal proof of concept that contains no real credentials or private data.
- Any mitigation you have already found.

We aim to acknowledge a report within three business days and provide an initial assessment within seven business days. Resolution time depends on the severity and complexity of the issue. We will keep reporters informed and coordinate disclosure when a fix is ready.

## What is in scope

Examples include:

- Running a command that the user did not save or approve.
- Bypassing review of a project setup created by a coding agent.
- Writing to an unintended file or location through Switchboard or its MCP server.
- Script or HTML injection in the Switchboard sidebar.
- Opening an unsafe or unexpected external URL.
- Stopping an unrelated process when checking or resolving a port conflict.
- Tampering with a published Switchboard package or its release process.

## What is not a vulnerability

- A command deliberately entered and run by the user doing what that command specifies.
- A trusted coding agent following instructions the user intentionally approved.
- Software already running with the same operating-system access modifying Switchboard's local data.
- Issues affecting an unsupported Switchboard version that do not reproduce on the latest release.
- Social engineering, physical access, or denial-of-service reports without a security impact.
- Automated scanner output without a reproducible security impact.

## Security model

Switchboard runs each saved start command and optional custom stop command as a shell command from the configured project folder. Commands inherit the environment and operating-system access of the VS Code process. Without a custom stop command, Switchboard targets only the process tree it launched. Only add projects and commands you trust, and review agent-created setups before running them.

Project configuration is stored in VS Code's local application data. Coding agents connected to Switchboard are separate products with their own permissions, data handling, and privacy settings.

## Responsible testing

Test only with systems and data you own or have permission to use. Avoid accessing other people's data, disrupting services, or using real credentials. We will not pursue action against good-faith research that follows these guidelines and gives us reasonable time to investigate and fix the issue before public disclosure.
