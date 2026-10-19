# Contributing

Questions about the format and reports of data that looks wrong are as
welcome as code. Open an issue first for anything larger than a fix, so two
people do not build the same thing.

## Pull requests

- One concern per pull request.
- Both test suites pass (see the [README](README.md)).
- A change to the format changes `FORMAT.md` first; code follows it.
- The tools follow `FORMAT.md` and the schema. Do not port code from the
  server into `tools/`: the server stands under another licence.

Pull requests that touch the format, the database, the worker configuration,
the licences or the workflows wait for the maintainer's label `human-ok`.

## Licence of contributions

Contributions fall under the licence of the file they go into (see
[LICENSE](LICENSE) and [REUSE.toml](REUSE.toml)). By opening a pull request
you agree to that.

Parts of this project are written with AI assistance (Claude Code), marked
with `Assisted-by:` in commits. Whoever uses AI checks the result and answers
for it as for their own work.
