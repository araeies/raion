# Contributing to Raion

Raion is open source, and reports from people who use it are what make it better. This page explains how the project is run and how to help.

## How Raion is run

Raion has a single owner and maintainer, who decides its architecture, design, user experience, technology choices and roadmap. It is open source, but **not community-governed**: there is no shared ownership of its design or direction, and contributions do not come with a say in them. See [GOVERNANCE](GOVERNANCE.md).

The way to influence Raion is to **open an issue**. The maintainer reads every issue and decides what Raion does about it. A clear, well-explained report is the most valuable contribution you can make.

## What to report

| You found                                                   | Open                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Something that does not work as documented                  | a **Bug report**                                                               |
| Something hard to understand or use                         | a **Usability problem**                                                        |
| Documentation that is wrong, unclear or missing             | a **Documentation problem**                                                    |
| A capability you need that Raion does not have              | a **Suggestion**                                                               |
| A technology Raion should support (a language, a database…) | an **Integration request**                                                     |
| A security vulnerability                                    | **not an issue**: report it privately, as described in [SECURITY](SECURITY.md) |

Search existing issues first; if yours exists, add what is new to it rather than opening another.

## A useful report

A report the maintainer can act on usually includes:

- **What you were trying to do**, and why: the goal, not only the command.
- **What happened**, and what you expected instead.
- **How to reproduce it**: the smallest workspace and the commands that show the problem.
- **Output**: the full output of the failing command. `raion validate --format json`, `raion status` and `raion --version` help with most problems.
- **Where you run it**: operating system, Docker version, and whether it is Docker Desktop.

**Remove secrets** before pasting anything: passwords, tokens, webhook URLs, internal hostnames. Workspace files never contain secret values, but command output and environment variables can.

## What happens next

The maintainer reviews each issue and decides whether, how and when to address it. An issue may be accepted, deferred or declined, even when the request is reasonable, because it does not fit Raion's design or direction. A declined issue is not a judgement of its author.

## Pull requests

Pull requests are welcome **only within the boundaries the maintainer defines**:

- **Typo and wording fixes in the documentation** can be sent directly.
- **Anything else needs an accepted issue first.** If the maintainer would welcome a pull request, the issue says so and describes the scope. Keep to that scope.
- Pull requests that redesign existing behaviour, change the architecture, add dependencies, or were not agreed in an issue will be closed, however good the code.

When you have been asked for a pull request, [Developing Raion](docs/internal/development.md) explains how to build, test and check your change. By submitting a pull request, you agree that it is licensed under the project's [Apache-2.0 licence](LICENSE).

## Code of conduct

Everyone taking part in the project's issues and discussions follows the [Code of Conduct](CODE_OF_CONDUCT.md).
