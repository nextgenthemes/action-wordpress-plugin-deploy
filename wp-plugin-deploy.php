#!/usr/bin/php
<?php

declare(strict_types = 1);

use function escapeshellarg as e;
// phpcs:disable WordPress.WP.AlternativeFunctions
// Allow functions and class in the same file
// phpcs:disable Universal.Files.SeparateFunctionsFromOO.Mixed

exit_on_warnings();

( new Deploy() )->run();

class Deploy {
	private ?string $workdir;
	private string $slug;
	private string $plugin_dir;
	private string $git_toplevel_dir;

	/**
	 * relative path from $git_toplevel_dir to $plugin_dir
	 *
	 * @var string
	 */
	private string $subdir;
	private ?string $svn_user;
	private ?string $svn_pass;
	private array $build_dirs;
	private ?string $version;
	private string $svn_url;
	private string $tmp_dir = '/tmp/wp-deploy';
	private string $svn_dir;
	private string $gitarch_dir;
	private bool $readme_only;
	private bool $dry_run;
	private bool $verbose;
	private string $commit_msg;

	public function __construct() {

		$this->verbose = has_arg( 'verbose' );
		$this->workdir = arg_with_default( 'workdir', null );

		if ( $this->workdir ) {
			chdir( getcwd() . "/$this->workdir" );
		}

		$this->fix_github_action_git_config();

		$this->slug             = basename( getcwd() );
		$this->plugin_dir       = getcwd();
		$this->git_toplevel_dir = $this->cmd( 'git rev-parse --show-toplevel' );
		$this->subdir           = trim( str_replace( $this->git_toplevel_dir, '', getcwd() ), '/' );
		$this->svn_user         = arg_with_default( 'svn-user', null );
		$this->svn_pass         = arg_with_default( 'svn-pass', null );
		$this->build_dirs       = comma_separated_string_to_array( arg_with_default( 'build-dirs', '' ) );
		$this->version          = arg_with_default( 'version', null );
		$this->svn_url          = "https://plugins.svn.wordpress.org/{$this->slug}/";
		$this->svn_dir          = "{$this->tmp_dir}/svn-{$this->slug}";
		$this->gitarch_dir      = "{$this->tmp_dir}/git-archive-{$this->slug}";
		$this->readme_only      = has_arg( 'readme-and-assets-only' );
		$this->dry_run          = has_arg( 'dry-run' );

		if ( $this->readme_only ) {
			$this->commit_msg = 'Update readme and assets with NextgenThemes WordPress Plugin Deploy';
		} else {
			$this->version    = required_arg( 'version' );
			$this->commit_msg = "Update plugin to version {$this->version} with NextgenThemes WordPress Plugin Deploy";
		}

		if ( $this->verbose ) {
			var_export( get_object_vars( $this ) );
		}
	}

	private function fix_github_action_git_config(): void {
		if ( getenv( 'GITHUB_ACTION' ) ) {
			$this->cmd( 'git config --global --add safe.directory ' . e( getcwd() ) );
		}
	}

	public function run(): void {

		// remove temp dir if exists
		$this->cmd( 'rm -rf ' . e( $this->tmp_dir ) );

		# Checkout just trunk and assets for efficiency
		# Tagging will be handled on the SVN level
		echo '➤ Checking out wp.org repository...' . PHP_EOL;
		$this->cmd( sprintf( 'svn checkout --depth immediates %s %s', e( $this->svn_url ), e( $this->svn_dir ) ) );

		chdir( $this->svn_dir );
		$this->cmd( 'svn update --set-depth infinity assets' );
		$this->cmd( 'svn update --set-depth infinity trunk' );

		echo '➤ Copying files...' . PHP_EOL;

		if ( $this->readme_only ) {
			$stable_tag = get_stable_tag_from_readme( "$this->plugin_dir/readme.txt" );
			$this->cmd( 'svn update --set-depth immediates '.e( "{$this->svn_dir}/tags/$stable_tag" ) );
			copy( "$this->plugin_dir/readme.txt", "$this->svn_dir/tags/$stable_tag/readme.txt" );
			copy( "$this->plugin_dir/readme.txt", "$this->svn_dir/trunk/readme.txt" );
		} else {
			mkdir( $this->gitarch_dir );
			$this->cmd(
				sprintf(
					'git --git-dir=%s archive %s | tar x --directory=%s',
					e( "$this->git_toplevel_dir/.git" ),
					e( $this->version . ':' . $this->subdir ),
					e( $this->gitarch_dir )
				)
			);
			$this->cmd( 'rsync -rc '.e( "$this->gitarch_dir/" ).' '.e( "$this->svn_dir/trunk" ).' --delete --delete-excluded' );

			foreach ( $this->build_dirs as $build_dir ) {

				if ( ! file_exists( "$this->plugin_dir/$build_dir" ) ) {
					echo 'Build dir '.e( "$this->plugin_dir/$build_dir" ).' does not exists.' . PHP_EOL;
					exit( 1 );
				}

				$this->cmd( 'rsync -rc '.e( "$this->plugin_dir/$build_dir" ).' '.e( "$this->svn_dir/trunk/" ).' --delete' );
			}
		}

		$this->cmd( 'rsync -rc '.e( "$this->plugin_dir/.wordpress-org/" ).' '.e( "$this->svn_dir/assets" ).' --delete' );

		# Add everything and commit to SVN
		# The force flag ensures we recurse into subdirectories even if they are already added
		echo '➤ Preparing files...' . PHP_EOL;
		$this->cmd( 'svn add . --force --quiet' );

		# SVN delete all deleted files
		# Also suppress stdout here
		$this->cmd( "svn status | grep '^\!' | sed 's/! *//' | xargs -I% svn rm %@ --quiet" );

		# Copy tag locally to make this a single commit
		if ( ! $this->readme_only ) {
			echo '➤ Copying tag...' . PHP_EOL;
			$this->cmd( 'svn cp trunk ' . e( "tags/$this->version" ) );
		}

		fix_screenshots();

		$this->cmd( 'svn status' );

		if ( $this->dry_run ) {
			echo '➤ Dry run exit' . PHP_EOL;
			exit( 0 );
		}

		# Commit to SVN
		$commit_cmd = 'svn commit -m '.e( $this->commit_msg ).' ';
		if ( $this->svn_user && $this->svn_pass ) {
			$commit_cmd .= ' --no-auth-cache --non-interactive --username '.e( $this->svn_user ).' --password '.e( $this->svn_pass );
		}
		echo '➤ Committing files...' . PHP_EOL;
		$this->cmd( $commit_cmd );

		echo '✓ Plugin deployed!';
	}

	/**
	 * Executes a system command with optional arguments.
	 *
	 * @param string $command The system command to execute
	 * @param array $args An associative array of optional --arg="x" command arguments
	 * @return string The output of the system command
	 */
	private function cmd( string $command, array $args = array() ): string {

		foreach ( $args as $k => $v ) {
			$command .= " --$k=" . escapeshellarg( $v );
		}

		if ( $this->verbose ) {
			echo "Executing: $command" . PHP_EOL;
			$out = system( $command, $exit_code );
		} else {
			$out = exec( command: $command, result_code: $exit_code );
		}

		if ( 0 !== $exit_code || false === $out ) {
			echo "Exit Code: $exit_code" . PHP_EOL;
			exit( $exit_code );
		}

		return $out;
	}
}

function get_stable_tag_from_readme( string $readme_file ): string {

	if ( ! is_file( $readme_file ) ) {
		echo 'No readme.txt found'. PHP_EOL;
		exit( 1 );
	}

	$handle = fopen( $readme_file, 'r' );
	$str    = fread( $handle, 4096 );
	fclose( $handle );

	$re = '/^([*+-]\s+)?Stable tag:[ ]*(?<stable_tag>[^\s]+)/m';

	preg_match( $re, $str, $matches );

	if ( empty( $matches['stable_tag'] ) ) {
		echo 'No stable tag found in readme'. PHP_EOL;
		exit( 1 );
	}

	echo 'Detected Stable tag: ' . $matches['stable_tag'];

	return $matches['stable_tag'];
}

/**
 * Fix the MIME type of image files in the assets directory based on file extension. This prevents forced download
 * force downloaded when clicking them on wp.org
 *
 * @link https://developer.wordpress.org/plugins/wordpress-org/plugin-assets/
 */
function fix_screenshots(): void {
	if ( count( glob( 'assets/*.png' ) ) > 0 ) {
		system( 'svn propset svn:mime-type image/png assets/*.png' );
	}
	if ( count( glob( 'assets/*.jpg' ) ) > 0 ) {
		system( 'svn propset svn:mime-type image/jpeg assets/*.jpg' );
	}
	if ( count( glob( 'assets/*.gif' ) ) > 0 ) {
		system( 'svn propset svn:mime-type image/gif assets/*.gif' );
	}
	if ( count( glob( 'assets/*.svg' ) ) > 0 ) {
		system( 'svn propset svn:mime-type image/svg+xml assets/*.svg' );
	}
}

/**
 * Check if the specified argument is present in the command line arguments.
 *
 * @param string $arg The argument to check for in the command line arguments.
 * @return bool True if the argument is present, false otherwise.
 */
function has_arg( string $arg ): bool {
	$getopt = getopt( '', array( $arg ) );
	return isset( $getopt[ $arg ] );
}

/**
 * Validates and returns the value of the required argument.
 *
 * @param string $arg The name of the required argument.
 * @throws Exception If the required argument is not provided.
 * @return string The value of the required argument.
 */
function required_arg( string $arg ): string {

	$getopt = getopt( '', array( "$arg:" ) );

	if ( empty( $getopt[ $arg ] ) ) {
		echo "need --$arg=x";
		exit( 1 );
	}

	return $getopt[ $arg ];
}

/**
 * A function that retrieves the value of a specified command-line argument, with a default value if the argument is not provided.
 *
 * @param string $arg The name of the command-line argument to retrieve.
 * @param mixed $default_value The default value to return if the command-line argument is not provided.
 * @return mixed The value of the specified command-line argument, or the default value if the argument is not provided.
 */
function arg_with_default( string $arg, mixed $default_value ): mixed {

	$getopt = getopt( '', array( "$arg::" ) );

	if ( empty( $getopt[ $arg ] ) ) {
		return $default_value;
	}

	return $getopt[ $arg ];
}

/**
 * Sets up a custom error handler to exit the script on warnings and fatal errors.
 *
 * @throws void This function does not throw any exceptions.
 * @return void This function does not return any value.
 */
function exit_on_warnings(): void {

	set_error_handler(
		function ( int $err_no, string $err_str, string $err_file, int $err_line ): bool {
			$error_type_str = 'Error';
			// Source of the switch logic: default error handler in PHP's main.c
			switch ( $err_no ) {
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
				fwrite( STDERR, "PHP $error_type_str:  $err_str in $err_file on line $err_line\n" );
				exit( 1 );
			}

			return false;
		},
		E_ALL
	);
}

/**
 * Takes a comma-separated string as input and converts it into an array.
 * It removes any leading or trailing spaces from each element and filters out
 * any empty elements from the resulting array.
 *
 * @param string $str The input comma-separated string
 * @return array The resulting array
 */
function comma_separated_string_to_array( string $str ): array {

	// Trim spaces from each element
	$ar = array_map( 'trim', explode( ',', $str ) );

	// Filter out empty elements
	$ar = array_filter( $ar, 'strlen' );

	// Remove duplicate elements
	$ar = array_unique( $ar );

	return $ar;
}
