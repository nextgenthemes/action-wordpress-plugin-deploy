#!/usr/bin/php
<?php
use function \escapeshellarg as e;
exit_on_warnings();

$GLOBALS['verbose'] = has_arg('verbose');
$workdir            = arg_with_default('workdir', false);

if ( $workdir ) {
	chdir( getcwd() . "/$workdir" );
}

if ( getenv( 'GITHUB_ACTION' ) ) {
	sys('git config --global --add safe.directory ' . e( getcwd() ) );
}

$slug             = basename(getcwd());
$plugin_dir       = getcwd();
$git_toplevel_dir = sys('git rev-parse --show-toplevel');
$subdir           = trim(str_replace($git_toplevel_dir, '', getcwd()), '/');
$svn_user         = arg_with_default('svn-user', false);
$svn_pass         = arg_with_default('svn-pass', false);
$build_dirs       = array_map( 'trim', explode(',', arg_with_default('build-dirs', '')) );
$version          = arg_with_default('version', false);
$svn_url          = "https://plugins.svn.wordpress.org/$slug/";
$tmp_dir          = '/tmp/wp-deploy';
$svn_dir          = "$tmp_dir/svn-$slug";
$gitarch_dir      = "$tmp_dir/git-archive-$slug";
$readme_only      = has_arg('readme-and-assets-only');
$dry_run          = has_arg('dry-run');

if ( $readme_only ) {
	$commit_msg = 'Update readme and assets with NextgenThemes WordPress Plugin Deploy';
} else {
	$version    = required_arg('version');
	$commit_msg = "Update to $version with NextgenThemes WordPress Plugin Deploy";
}

if ( $GLOBALS['verbose'] ) {
	$defined_vars = get_defined_vars();
	unset($defined_vars['argc']);
	unset($defined_vars['_COOKIE']);
	unset($defined_vars['_ENV']);
	unset($defined_vars['_FILES']);
	unset($defined_vars['_GET']);
	unset($defined_vars['_POST']);
	unset($defined_vars['_REQUEST']);
	unset($defined_vars['_SERVER']);
	var_export( $defined_vars );
}

sys('rm -rf ' . e($tmp_dir) );

# Checkout just trunk and assets for efficiency
# Tagging will be handled on the SVN level
echo '➤ Checking out wp.org repository...' . PHP_EOL;
sys( sprintf( 'svn checkout --depth immediates %s %s', e($svn_url), e($svn_dir) ) );

chdir($svn_dir);
sys('svn update --set-depth infinity assets');
sys('svn update --set-depth infinity trunk');

echo '➤ Copying files...' . PHP_EOL;

if ( $readme_only ) {
	$stable_tag = get_stable_tag_from_readme( "$plugin_dir/readme.txt" );
	sys('svn update --set-depth immediates '.e("$svn_dir/tags/$stable_tag"));
	copy( "$plugin_dir/readme.txt", "$svn_dir/tags/$stable_tag/readme.txt" );
	copy( "$plugin_dir/readme.txt", "$svn_dir/trunk/readme.txt" );
} else {
	mkdir($gitarch_dir);
	sys(
		sprintf(
			'git --git-dir=%s archive %s | tar x --directory=%s',
			e("$git_toplevel_dir/.git"),
			e("$version:$subdir"),
			e($gitarch_dir)
		)
	);
	sys('rsync -rc '.e("$gitarch_dir/").' '.e("$svn_dir/trunk").' --delete --delete-excluded');

	foreach ( $build_dirs as $build_dir ) {

		if ( ! file_exists( "$plugin_dir/$build_dir" ) ) {
			echo 'Build dir '.e("$plugin_dir/$build_dir").' does not exists.' . PHP_EOL;
			exit(1);
		}

		sys('rsync -rc '.e("$plugin_dir/$build_dir").' '.e("$svn_dir/trunk/").' --delete');
	}
}

sys('rsync -rc '.e("$plugin_dir/.wordpress-org/").' '.e("$svn_dir/assets").' --delete');

# Add everything and commit to SVN
# The force flag ensures we recurse into subdirectories even if they are already added
echo '➤ Preparing files...' . PHP_EOL;
sys('svn add . --force --quiet');

# SVN delete all deleted files
# Also suppress stdout here
sys("svn status | grep '^\!' | sed 's/! *//' | xargs -I% svn rm %@ --quiet");

# Copy tag locally to make this a single commit
if ( ! $readme_only ) {
	echo '➤ Copying tag...' . PHP_EOL;
	sys('svn cp trunk ' . e("tags/$version"));
}

# Fix screenshots getting force downloaded when clicking them
# https://developer.wordpress.org/plugins/wordpress-org/plugin-assets/
fix_screenshots();

sys('svn status');
if ( $dry_run ) {
	echo '➤ Dry run exit' . PHP_EOL;
	exit(1);
}
$commit_cmd = 'svn commit -m '.e($commit_msg).' ';
if ( $svn_user && $svn_pass ) {
	$commit_cmd .= ' --no-auth-cache --non-interactive --username '.e($svn_user).' --password '.e($svn_pass);
}
echo '➤ Committing files...' . PHP_EOL;
sys($commit_cmd);

echo '✓ Plugin deployed!';

function get_stable_tag_from_readme( string $readme_file ) {

	if ( ! is_file( $readme_file ) ) {
		echo 'No readme.txt found'. PHP_EOL;
		exit(1);
	}

	// phpcs:disable WordPress.WP.AlternativeFunctions
	$handle = fopen($readme_file, 'r');
	$str    = fread($handle, 4096);
	fclose($handle);

	$re = '/^([*+-]\s+)?Stable tag:[ ]*(?<stable_tag>[^\s]+)/m';

	preg_match($re, $str, $matches);

	if ( empty( $matches['stable_tag'] ) ) {
		echo 'No stable tag found in readme'. PHP_EOL;
		exit(1);
	}

	echo 'Detected Stable tag: ' . $matches['stable_tag'];

	return $matches['stable_tag'];
}

function fix_screenshots() {
	if ( count(glob('assets/*.png')) > 0 ) {
		system('svn propset svn:mime-type image/png assets/*.png');
	}
	if ( count(glob('assets/*.jpg')) > 0 ) {
		system('svn propset svn:mime-type image/jpeg assets/*.jpg');
	}
	if ( count(glob('assets/*.gif')) > 0 ) {
		system('svn propset svn:mime-type image/gif assets/*.gif');
	}
	if ( count(glob('assets/*.svg')) > 0 ) {
		system('svn propset svn:mime-type image/svg+xml assets/*.svg');
	}
}

function has_arg( string $arg ): bool {
	$getopt = getopt( '', [ $arg ] );
	return isset($getopt[ $arg ]);
}

function required_arg( string $arg ): string {

	$getopt = getopt( '', [ "$arg:" ] );

	if ( empty($getopt[ $arg ]) ) {
		echo "need --$arg=x";
		exit(1);
	}

	return $getopt[ $arg ];
}

function arg_with_default( string $arg, $default ) {

	$getopt = getopt( '', [ "$arg::" ] );

	if ( empty($getopt[ $arg ]) ) {
		return $default;
	}

	return $getopt[ $arg ];
}

function sys( string $command, array $args = [] ): string {

	foreach ( $args as $k => $v ) {
		$command .= " --$k=" . escapeshellarg($v);
	}

	if ( $GLOBALS['verbose'] ) {
		echo "Executing: $command" . PHP_EOL;
		$out = system( $command, $exit_code );
	} else {
		$out = exec( $command, $exec_output, $exit_code );
	}

	if ( 0 !== $exit_code || false === $out ) {
		echo "Exit Code: $exit_code" . PHP_EOL;
		exit($exit_code);
	}

	return $out;
}

function exit_on_warnings() {

	set_error_handler(
		function($err_no, $err_str, $err_file, $err_line) {
			$error_type_str = 'Error';
			// Source of the switch logic: default error handler in PHP's main.c
			switch ($err_no) {
				case E_ERROR:
				case E_CORE_ERROR:
				case E_COMPILE_ERROR:
				case E_USER_ERROR:
					$error_type_str = 'Fatal error';
					break;
				case E_RECOVERABLE_ERROR:
					$error_type_str = 'Recoverable fatal error';
					break;
				case E_WARNING:
				case E_CORE_WARNING:
				case E_COMPILE_WARNING:
				case E_USER_WARNING:
					$error_type_str = 'Warning';
					break;
				case E_PARSE:
					$error_type_str = 'Parse error';
					break;
				case E_NOTICE:
				case E_USER_NOTICE:
					$error_type_str = 'Notice';
					break;
				case E_STRICT:
					$error_type_str = 'Strict Standards';
					break;
				case E_DEPRECATED:
				case E_USER_DEPRECATED:
					$error_type_str = 'Deprecated';
					break;
				default:
					$error_type_str = 'Unknown error';
					break;
			}

			if ( 'Warning' === $error_type_str ) {
				fwrite(STDERR, "PHP $error_type_str:  $err_str in $err_file on line $err_line\n");
				exit(1);
			}

			return false;
		},
		E_ALL
	);
}

