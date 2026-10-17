# Contributing to Habblaud

Thank you for your interest in contributing to Habblaud! Bug reports, feature ideas, and improvements are always welcome.

## Before starting

- For bugs and ideas, check the [issues](https://github.com/marmottajr/habblaud/issues) to see if the subject has already been registered.
- For major changes or those that alter Habblaud's behavior, please open an issue to discuss your proposal before implementing it.
- Prefer small, focused changes. If your change modifies what appears or happens in the office, please describe this behavior in the pull request.

## Environment setup

Habblaud requires Node.js 22.12 or later and npm. After cloning the repository:

```sh
npm install
npm run dev
```

The development office is available at <http://localhost:4747>.

## Texts and translations

Habblaud has an interface available in Portuguese, English, Spanish, and French. Portuguese is the source language:

- All text visible to users (interface, errors, logs, installation scripts) is written in Portuguese within `tr()` calls (`shared/i18n.ts`). Values are passed using numbered placeholders: `tr('Reading {0}', [file])`, never using template strings inside `tr()`.
- The translation key is the Portuguese text itself: changing the text changes the key. Update its translations in `shared/locales/` (`en.ts`, `es.ts`, `fr.ts`) or leave them out: text without a translation appears in Portuguese.
- `npm run i18n:check` lists texts without translations and orphaned translations.

## Verifying changes

Before opening a pull request, run:

```sh
npm run typecheck
npm test
npm run build
```

If the change affects a Claude Code plugin, validate the affected plugin as well:

```sh
claude plugin validate mod/habblaud
claude plugin test mod/habblaud
```

Use the path of the modified plugin (`mod/habblaud-permissions` or `mod/habblaud-messages`) as appropriate.

## Opening a pull request

- Use a clear title and explain the problem, the change, and how it was verified.
- Reference the related issue, if applicable.
- For visual changes, include a screenshot or GIF if it helps demonstrate the result. Take captures in demonstration mode (`?mock=1` in the URL or `npm run demo`), which shows only dummy agents.
- Update the **Unreleased** section of `CHANGELOG.md` when the change introduces something visible to Habblaud users.
- PRs that touch `shared/world/` or `server/world/` (Habblaud World) must explain what changes in the data being sent from the machine, and the review will check the list in [`docs/world/privacidade.md`](docs/world/privacidade.md) against the code. Read [`shared/world/README.md`](shared/world/README.md) beforehand.
- Do not include personal data, credentials, or private session content in captures, examples, or logs.

If something is unclear, ask in the related issue before pursuing a direction that might change the project's behavior.
