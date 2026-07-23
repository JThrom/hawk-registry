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
| `installNotes`| no       | string (markdown) | Extracted README install section; shown when no manager fits.|
| `readmeUrl`   | no       | string (URL)      | Raw URL of the full README (sidecar in `readmes/`).          |
| `launch`      | no       | object            | Launch arguments prompted before launch (see below).         |

Most optional fields are auto-populated by `scripts/enrich.ts` from the
project README; hand-curated values are preserved.

### Launch arguments (`launch.args`)

Apps that need parameters (e.g. a directory) declare them so Hawk can prompt:

```yaml
launch:
  args:
    - name: path            # required: shown in the prompt + details
      description: Directory to open
      required: false       # if true, the user must supply a value
      placeholder: ~/projects
      default: "."          # pre-filled value
      flag: --path          # optional: passed as "--path <value>"; omit = positional
```

### Valid package managers

`brew`, `apt`, `pacman`, `cargo`, `npm`, `bun`, `pipx`, `pip`, `dnf`, `go`

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
