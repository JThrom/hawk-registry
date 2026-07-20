# hawk-registry

Community registry of terminal user interfaces (TUIs) for the
[Hawk](https://github.com/JThrom/hawk) launcher.

Hawk uses this registry to suggest apps you can install. Each app is a small
YAML file under [`apps/`](./apps). CI compiles them into
[`dist/index.yaml`](./dist/index.yaml), which Hawk fetches over the jsDelivr CDN.

## Adding or editing an app

1. Create or edit `apps/<id>.yaml` (see [SCHEMA.md](./SCHEMA.md) for fields).
2. If it needs a new category, add it to [`categories.yaml`](./categories.yaml).
3. Open a pull request. CI validates your entry.

Once merged to `master`, CI rebuilds `dist/index.yaml` automatically.

### Example `apps/lazygit.yaml`

```yaml
id: lazygit
name: lazygit
description: Simple terminal UI for git commands
categories:
  - git
  - dev
tags:
  - git
  - vcs
binaries:
  - lazygit
packages:
  brew: lazygit
  pacman: lazygit
install:
  brew: brew install lazygit
  pacman: pacman -S lazygit
homepage: https://github.com/jesseduffield/lazygit
repo: https://github.com/jesseduffield/lazygit
popularity: 55000
language: Go
```

## README enrichment

Most app metadata (`language`, `install`, `packages`, `tags`, `installNotes`)
is inferred from each project's GitHub README by `scripts/enrich.ts`:

- Fetches the README via `raw.githubusercontent.com/<owner>/<repo>/HEAD`
  (no API rate limit) and stores it as a sidecar `readmes/<id>.readme.md`.
- Infers install commands + package names (brew/cargo/go/pip/pipx/npm/bun/
  apt/dnf/pacman), language, function/synonym tags, and extracts the
  README's installation section into `installNotes`.
- Curated values already present in `apps/<id>.yaml` are never overwritten.

```bash
bun run enrich                 # enrich all apps (resumable; skips cached READMEs)
bun run enrich -- --force      # re-fetch + re-infer everything
bun run enrich -- --only lazygit
```

`installNotes` is shown by Hawk when an app has no install command available
on the user's system, so they can follow the project's own instructions.

## Local development

```bash
bun install
bun run enrich     # infer metadata from READMEs (see above)
bun run build      # apps/*.yaml + categories.yaml -> dist/index.yaml
bun run validate   # validate without writing (same check CI runs on PRs)
```

`scripts/split.ts` is a one-time seeder that generated `apps/` from an
aggregated source; it is not needed for normal contributions.

## Consumed by Hawk

Hawk fetches (see its `registry.urls` config):

```
https://cdn.jsdelivr.net/gh/JThrom/hawk-registry@master/dist/index.yaml
https://raw.githubusercontent.com/JThrom/hawk-registry/master/dist/index.yaml
```

## License

MIT
