# WordPress.org Plugin Deploy

> Deploy your plugin to the WordPress.org repository using GitHub Actions.

This Action commits the contents of your Git tag to the WordPress.org plugin repository using the same tag name. It can exclude files as defined in either or `.gitattributes`, and moves anything from a `.wordpress-org` subdirectory to the top-level `assets` directory in Subversion (plugin banners, icons, and screenshots).

This is based on [https://github.com/10up/action-wordpress-plugin-deploy](10up/action-wordpress-plugin-deploy) but with a major difference. Its works **locally** and on Github actions.

One of the reasons I originally created this was the lack of the ability to run the action in a different directory. You can do that with `workdir`. I aim for simplicity.

It also supports monorepos or setups where your plugin is in a subdirectory of a git repository. 

## Configuration

### Required secrets

`SVN_USERNAME` and `SVN_PASSWORD`

[Secrets are set in your repository settings](https://help.github.com/en/actions/automating-your-workflow-with-github-actions/creating-and-using-encrypted-secrets). They cannot be viewed once stored.

### Example run configuration ###

1. This runs only if a previews run named `test` succeeded. And if the commit it an actual tag that does not have `alpha` in the tag.
1. Key part on the checkout is you need to checkout inside a directory that is named after your plugin slug.
1. The action 

```yaml
  deploy:
    if: >-
      startsWith(github.ref, 'refs/tags')
      && ! contains(github.ref, 'alpha')
    needs: test
    name: SVN commit to wp.org
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
        with:
          path: your-plugin-slug

      - name: Get the version
        id: get_version
        run: echo "VERSION=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT

      - name: Deploy
        uses: nextgenthemes/action-wordpress-plugin-deploy@stable
        with:
          workdir: your-plugin-slug
          version: ${{ steps.get_version.outputs.VERSION }}
          svn_user: ${{ secrets.SVN_USERNAME }}
          svn_pass: ${{ secrets.SVN_PASSWORD }}
```

Lets say you have a monorepo or subdirectory git setup. Given a `plugins/your-plugin-slug` directory inside your git, you wound use no `path:` for the checkout and for the 'Deploy' `workdir` you would use `plugins/your-plugin-slug`.

## Running it locally

Should run on MacOS and probably everywhere where you can install rsync, subversion and php-cli. On Windows use WSL. Only tested with Ubuntu 22.04.

You need subversion and php-cli installed. On Debian/Ubuntu and derivatives you can do:

```bash
sudo apt install php-cli subversion rsync
```

Download the script and make it executable.

```bash
wget https://raw.githubusercontent.com/nextgenthemes/action-wordpress-plugin-deploy/master/wp-plugin-deploy --output-document=~/bin/
chmod +x ~/bin/wp-plugin-deploy
```

You now can release your plugin to wp.org directly. The plugin slug is taken from the directory name. This needs to be git versioned and the version you want to deploy needs to be tagged. This will do a `git achieve` for the `--version=` tag you feed to the script. This will **not** deploy the current files you have checked out. Meaning you can be on `experimental-branch-xyz` working on a broken plugin as long as you correctly tagged a stable version in git previously you can release that version to wp.org without switching branches or checking out that tag.

If you do not supply --svn-user and --svn-pass (you should not) you should be asked for your wp.org credentials and your OS may save them and may later be able deploy without a password or by only unlocking your OS password manager.

```bash
cd /path/to/your-plugin-slug
wp-plugin-deploy --version=1.0.0
```

It the output looks ok you can inspect your `/tmp/wp-deploy` directory and check of every
