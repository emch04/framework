# Security Policy

## Supported versions

Astratra packages follow semantic versioning and are all at version 1.x or
later. Security fixes are made on the latest release of each package and are
published as a new version. Older major versions are not patched; upgrade to
the latest major version of the package you use.

| Version | Supported |
|---|---|
| Latest 1.x or 2.x release of each package | Yes |
| Earlier releases of a package | No, upgrade to the latest release |

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue, a pull
request or a discussion about a vulnerability.

Use **private vulnerability reporting through GitHub Security Advisories**:
open the **Security** tab of this repository and choose **Report a
vulnerability**. This sends the report only to the maintainers.

Include, if you can:

- the name and version of the affected package (from its `package.json`);
- a description of the impact and of who can exploit it;
- the smallest reproduction you can build, without real credentials, personal
  data or production systems;
- whether you already know of a fix or a workaround.

Never include real secrets, tokens or personal data in a report. Use test
values.

## What to expect

These timelines are indicative and depend on the maintainers' availability:

- acknowledgement of your report within about 7 days;
- a first assessment (accepted, needs more information, or not a
  vulnerability) within about 14 days;
- a fix and a coordinated disclosure as soon as a fix is available, with a
  new package version and a CHANGELOG entry. Severe issues are prioritised.

You will be credited in the advisory if you wish. There is no bug bounty
programme.

## Scope

In scope: the code of the published packages in `packages/`, and the
generator templates shipped by `create-astratra-app`.

Out of scope: the unpublished example in `examples/`, misconfiguration of a
project built with Astratra (for example, disabled authentication or a
production secret committed in an application), and issues that need a
compromised developer machine or npm account.

Astratra's security packages reduce common risks, but they do not replace a
review of your own application. The limits of each package are described in its
README.
