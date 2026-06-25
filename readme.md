# WordPress.org Plugin Deploy

Deploy your plugin to the WordPress.org repository via GitHub Actions (or locally). Uses `git archive` to export the
tagged commit, rsyncs it into SVN trunk, and copies `.wordpress-org/` to `assets/`.

Based on [10up/action-wordpress-plugin-deploy](https://github.com/10up/action-wordpress-plugin-deploy), rewritten in
TypeScript (originally PHP) with monorepo support and local execution.

### Comparison with 10up/action-wordpress-plugin-deploy

| Feature                         | 10up `deploy.sh`                      | This action `wp-plugin-deploy.ts`            |
| ------------------------------- | ------------------------------------- | -------------------------------------------- |
| written in                      | bash                                  | ~~php~~ typescript                           |
| Source of files                 | rsync from workspace OR `git archive` | `git archive` only                           |
| `.distignore` support           | Yes (rsync path only)                 | No                                           |
| `.gitattributes`                | Used as fallback                      | Yes — `git archive` respects it              |
| Ships untracked vendor          | Only with `.distignore` (rsync path)  | No by default, use `--build-dirs=vendor`     |
| Monorepo / subdirectory support | No                                    | Yes                                          |
| `--build-dirs` param            | No                                    | Yes — rsync extra dirs on top of the archive |
| `BUILD_DIR` env (full replace)  | Yes                                   | No                                           |
| `ASSETS_DIR` env override       | Yes — defaults to `.wordpress-org`    | No — hardcoded to `.wordpress-org`           |
| `SLUG` env override             | Yes — defaults to repo name           | No — always derived from directory name      |
| `--readme-and-assets-only`      | No                                    | Yes                                          |
| `generate-zip` default          | `false`                               | `true` (via action.yml input default)        |
| Runs locally                    | No                                    | Yes (Requires Deno)                          |
| Dry-run mode                    | Yes                                   | Yes                                          |

## Required secrets

- `SVN_USERNAME` — WP.org username
- `SVN_PASSWORD` — WP.org password

## Inputs

| Input                    | Required | Description                                                     |
| ------------------------ | -------- | --------------------------------------------------------------- |
| `svn_user`               | yes      | WP.org username                                                 |
| `svn_pass`               | yes      | WP.org password                                                 |
| `version`                | no*      | Git tag to deploy (required unless `readme-and-assets-only`)    |
| `workdir`                | no       | Relative path to plugin directory (slug detected from dir name) |
| `build_dirs`             | no       | Comma-separated dirs to rsync on top of archive (e.g. `vendor`) |
| `readme-and-assets-only` | no       | Only update readme.txt and assets (boolean)                     |
| `dry-run`                | no       | Exit before SVN commit (boolean)                                |
| `verbose`                | no       | Verbose output (boolean)                                        |

\* `version` is required when deploying a full release, not for readme-only updates.

## Slug detection

The plugin slug is taken from `basename(getcwd())` after applying `workdir`. For example, with
`workdir: plugins/my-slug`, the slug becomes `my-slug`. The SVN URL is derived as
`https://plugins.svn.wordpress.org/{slug}/`.

## Usage

```yaml
- name: Deploy
  uses: nextgenthemes/action-wordpress-plugin-deploy@master
  with:
   workdir: your-plugin-slug
   version: ${{ steps.get_version.outputs.VERSION }}
   svn_user: ${{ secrets.SVN_USERNAME }}
   svn_pass: ${{ secrets.SVN_PASSWORD }}
   build_dirs: vendor
   readme-and-assets-only: false
   dry-run: false
   verbose: true
```

### Full release example

Checkout into a directory matching the slug, deploy from it:

```yaml
deploy:
 if: startsWith(github.ref, 'refs/tags') && !contains(github.ref, 'alpha')
 runs-on: ubuntu-latest
 steps:
  - uses: actions/checkout@v3
    with:
     path: your-plugin-slug

  - name: Get the version
    id: get_version
    run: echo "VERSION=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT

  - name: Deploy
    uses: nextgenthemes/action-wordpress-plugin-deploy@master
    with:
     workdir: your-plugin-slug
     version: ${{ steps.get_version.outputs.VERSION }}
     svn_user: ${{ secrets.SVN_USERNAME }}
     svn_pass: ${{ secrets.SVN_PASSWORD }}
```

### Monorepo / subdirectory

If your plugin is at `plugins/your-plugin-slug`, omit `path:` and use `workdir: plugins/your-plugin-slug`.

### Readme-and-assets-only mode

When `readme-and-assets-only: true`, the action:

1. Reads the stable tag from `readme.txt` in the plugin directory
2. Updates `readme.txt` in both SVN trunk and the stable tag
3. Syncs `.wordpress-org/` to `assets/`
4. Does **not** require `version`

### build_dirs

Ship directories not tracked in git (e.g. Composer vendor). Run `composer install --no-dev` before the deploy step, then
pass `build_dirs: vendor`. The directory is rsynced into trunk on top of the `git archive` export. **Exits with error if
the directory doesn't exist.**

```yaml
- name: Install Composer dependencies
  run: composer install --no-dev --no-interaction --optimize-autoloader

- name: Deploy
  uses: nextgenthemes/action-wordpress-plugin-deploy@master
  with:
   build_dirs: vendor
```

## What the action does

1. Creates `/tmp/wp-deploy/` and checks out SVN trunk + assets
2. Runs `git archive <tag>:<subdir>` to export the tagged files
3. Rsyncs the archive into SVN trunk
4. If `build_dirs` is set, rsyncs those directories on top
5. Syncs `.wordpress-org/` to SVN `assets/`
6. Commits the tag via `svn cp trunk tags/<version>`
7. Sets `svn:mime-type` on PNG, JPG, GIF, and SVG assets
8. Commits to SVN (or exits on dry-run)

## Running locally

Requires `php-cli`, `subversion`, and `rsync`.

```bash
sudo apt install php-cli subversion rsync
wget -O ~/bin/wp-plugin-deploy https://raw.githubusercontent.com/nextgenthemes/action-wordpress-plugin-deploy/master/wp-plugin-deploy.php
chmod +x ~/bin/wp-plugin-deploy
```

Deploy a tagged version:

```bash
cd /path/to/your-plugin-slug
wp-plugin-deploy --version=1.0.0 --verbose
```

- Slug is taken from the directory name.
- Uses `git archive` for the tag — your working tree doesn't matter (except for `--readme-and-assets-only`).
- Without `--svn-user`/`--svn-pass`, you'll be prompted for credentials (OS keychain may remember them).
- Use `--dry-run` first, inspect `/tmp/wp-deploy` to verify.
