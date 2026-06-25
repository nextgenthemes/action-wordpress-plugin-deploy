# wp-plugin-deploy.php Process

## Folder Structure (GitHub Runner)

```
/home/runner/work/wpdev/wpdev/                    ← GITHUB_WORKSPACE (parent repo checked out by deploy job)
/home/runner/work/wpdev/wpdev/{plugin-slug}/       ← plugin repo checkout (e.g. tweakmaster)
/home/runner/work/_actions/nextgenthemes/action-wordpress-plugin-deploy/master/   ← this action's location

/tmp/wp-deploy/                                     ← temp working dir (cleaned at start)
  git-archive-{slug}/                               ← git archive extraction + build_dirs rsync
  svn-{slug}/                                       ← SVN checkout (only in SVN deploy path)
  {slug}                                            ← symlink to source dir for zipping

Output: /home/runner/work/wpdev/wpdev/{slug}.zip
```

## Steps

### 1. Parse CLI args

Reads `--workdir`, `--version`, `--build-dirs`, `--svn-user`, `--svn-pass`, `--verbose`, `--generate-zip`, `--readme-and-assets-only`, `--dry-run` from the command line. If `--workdir` is set, `chdir` into it.

### 2. Determine paths

- `slug` ← `basename(getcwd())`
- `plugin_dir` ← `getcwd()`
- `git_toplevel_dir` ← `git rev-parse --show-toplevel`
- `subdir` ← relative path from git toplevel to plugin dir (empty when they are the same)
- `svn_url` ← `https://plugins.svn.wordpress.org/{slug}/`
- `tmp_dir` ← `/tmp/wp-deploy`
- `svn_dir` ← `/tmp/wp-deploy/svn-{slug}`
- `gitarch_dir` ← `/tmp/wp-deploy/git-archive-{slug}`

### 3. `should_deploy()` check

Returns `false` (zip-only mode) if:
- `.wordpress-org` directory does not exist in the plugin dir, OR
- version tag contains `alpha`, `beta`, or `dev` (case-insensitive)

Otherwise returns `true` (full SVN deploy mode).

### 4. Clean temp

`rm -rf /tmp/wp-deploy`

### 5. Zip-only path (no SVN)

**5a. Prepare files**
- `mkdir /tmp/wp-deploy/git-archive-{slug}/`
- `git archive {tag} | tar x --directory=/tmp/wp-deploy/git-archive-{slug}/`
  - Uses `{tag}:{subdir}` ref format when subdir is set, plain `{tag}` otherwise
- `rsync -r --checksum --delete {plugin_dir}/{build_dir} /tmp/wp-deploy/git-archive-{slug}/`
  - Copies each build_dir (e.g. `vendor`) into the archive extraction

**5b. Generate zip**
- `symlink(source_dir, /tmp/wp-deploy/{slug})`
  - Symlink points to the archive extraction dir
- `chdir(/tmp/wp-deploy)`
- `zip -r {GITHUB_WORKSPACE}/{slug}.zip {slug}`
  - Zip follows the symlink, stores entries as `{slug}/...` (relative to tmp_dir)
- `chdir(original_cwd)`, `unlink(symlink)`
- Sets `zip-path` GitHub Actions output
- `exit(0)`

### 6. SVN deploy path

**6a. SVN checkout**
- `svn checkout --depth immediates {svn_url} /tmp/wp-deploy/svn-{slug}/`
- `svn update --set-depth infinity assets`
- `svn update --set-depth infinity trunk`

**6b. Copy files into SVN trunk**
- For readme-only updates:
  - Read stable tag from `readme.txt`
  - Copy `readme.txt` into SVN trunk and SVN tags/{stable_tag}
- For full deploys:
  - Same `prepare_files()` call as step 5a, targeting `{svn_dir}/trunk/`

**6c. Sync assets**
- `rsync -r --checksum --delete {plugin_dir}/.wordpress-org/ {svn_dir}/assets/`

**6d. SVN add/delete**
- `svn add . --force --quiet`
- `svn status | grep '^!' | xargs svn rm`

**6e. Create SVN tag**
- `svn cp trunk tags/{version}`

**6f. Fix screenshot MIME types**
- `svn propset svn:mime-type image/png assets/*.png`
- Same for jpg, gif, svg

**6g. Dry-run check**
- If `--dry-run` is set, prints status and exits

**6h. SVN commit**
- `svn commit -m "Update plugin to version {version} ..."`
- Uses `--username` / `--password` when provided

**6i. Generate zip**
- Same `generate_zip_from()` as step 5b, using `{svn_dir}/trunk` as source

**6j. Done**
- Prints "✓ Plugin deployed!"
