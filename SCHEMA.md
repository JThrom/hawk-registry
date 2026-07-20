# Registry schema

Each app is one YAML file in `apps/<id>.yaml`.

## App fields

| Field         | Required | Type              | Notes                                                        |
|---------------|----------|-------------------|--------------------------------------------------------------|
| `id`          | yes      | string            | Stable unique id. Matches the filename (`apps/<id>.yaml`).   |
| `name`        | yes      | string            | Display name.                                                |
| `description` | yes      | string            | One-line description (also used for search).                 |
| `categories`  | yes      | string[]          | One or more category ids from `categories.yaml`.             |
| `binaries`    | yes      | string[]          | Executable name(s). First is the primary launch command.     |
| `tags`        | no       | string[]          | Extra search terms.                                          |
| `install`     | no       | map<manager,cmd>  | Install command per package manager.                         |
| `packages`    | no       | map<manager,pkg>  | Package name per manager, used for install-detection.        |
| `homepage`    | no       | string (URL)      | Project homepage.                                            |
| `repo`        | no       | string (URL)      | Source repository.                                           |
| `popularity`  | no       | number            | Stars / rank signal for search ordering.                     |
| `language`    | no       | string            | Implementation language / runtime.                           |

### Valid package managers

`brew`, `apt`, `pacman`, `cargo`, `npm`, `bun`, `pipx`, `pip`, `dnf`

## Categories (`categories.yaml`)

```yaml
categories:
  - id: dev
    name: Development
    order: 10   # lower sorts higher in Hawk's sidebar
```

| Field   | Required | Notes                          |
|---------|----------|--------------------------------|
| `id`    | yes      | Referenced by app `categories` |
| `name`  | yes      | Display name                   |
| `order` | no       | Sort weight (asc)              |

## Built index (`dist/index.yaml`)

Produced by `scripts/build.ts`. Do not edit by hand — CI regenerates it.

```yaml
version: 1
generatedAt: <ISO timestamp>
categories: [ ... ]
entries: [ ... ]   # all apps, sorted by name
```
