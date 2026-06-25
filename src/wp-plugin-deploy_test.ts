import { assertEquals, assertStringIncludes } from '@std/assert';
import { exists } from '@std/fs';
import { join } from '@std/path';
import { $ } from '@david/dax';
import {
	buildCtx,
	generateZip,
	getStableTag,
	parseArgs,
	parseBuildDirs,
	prepareFiles,
	run,
	shouldDeploy,
	type CliArgs,
	type Ctx,
} from '../src/wp-plugin-deploy.ts';

const TEST_BASE = '/tmp/wp-deploy-test';

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeCtx(overrides: Partial<Ctx>): Ctx {
	const slug = 'test-plugin';
	return {
		slug,
		pluginDir: join(TEST_BASE, overrides.pluginDir ?? `ctx-${uid()}`),
		gitTopLevel: join(TEST_BASE, 'git-top'),
		subdir: '',
		version: '1.0.0',
		svnUser: undefined,
		svnPass: undefined,
		buildDirs: [],
		readmeOnly: false,
		verbose: false,
		generateZip: false,
		dryRun: false,
		tmpDir: '/tmp/wp-deploy',
		svnUrl: `https://plugins.svn.wordpress.org/${slug}/`,
		svnDir: '/tmp/test-svn',
		gitarchDir: '/tmp/test-gitarch',
		commitMsg: 'Update plugin to version 1.0.0',
		...overrides,
	};
}

async function hasSvn(): Promise<boolean> {
	try {
		const result = await $`svn --version`.noThrow();
		return result.code === 0;
	} catch {
		return false;
	}
}

// Placeholder — returns true by default so tests can opt in with .only or
// ignore manually. In CI we might check an env var here.
function shouldRunSvnTests(): boolean {
	return Deno.env.get('WP_DEPLOY_SVN_TESTS') === '1';
}

// ─── Unit: parseBuildDirs ───────────────────────────────────────────────────

Deno.test('parseBuildDirs — empty string returns empty array', () => {
	assertEquals(parseBuildDirs(''), []);
});

Deno.test('parseBuildDirs — single dir', () => {
	assertEquals(parseBuildDirs('vendor'), ['vendor']);
});

Deno.test('parseBuildDirs — multiple with whitespace', () => {
	assertEquals(parseBuildDirs('vendor, build, dist'), ['vendor', 'build', 'dist']);
});

Deno.test('parseBuildDirs — deduplicates', () => {
	assertEquals(parseBuildDirs('vendor, vendor, build'), ['vendor', 'build']);
});

Deno.test('parseBuildDirs — trims spaces', () => {
	assertEquals(parseBuildDirs('  vendor ,  build  '), ['vendor', 'build']);
});

// ─── Unit: parseArgs ────────────────────────────────────────────────────────

Deno.test('parseArgs — full set', () => {
	const args = parseArgs([
		'--version=2.0.0',
		'--workdir=plugins/my-plugin',
		'--build-dirs=vendor,assets',
		'--svn-user=user',
		'--svn-pass=pass',
		'--verbose',
		'--generate-zip',
		'--dry-run',
	]);
	assertEquals(args.version, '2.0.0');
	assertEquals(args.workdir, 'plugins/my-plugin');
	assertEquals(args.buildDirs, ['vendor', 'assets']);
	assertEquals(args.svnUser, 'user');
	assertEquals(args.svnPass, 'pass');
	assertEquals(args.readmeAndAssetsOnly, false);
	assertEquals(args.verbose, true);
	assertEquals(args.generateZip, true);
	assertEquals(args.dryRun, true);
});

Deno.test('parseArgs — readme-and-assets-only', () => {
	const args = parseArgs(['--readme-and-assets-only']);
	assertEquals(args.readmeAndAssetsOnly, true);
	assertEquals(args.version, undefined);
});

Deno.test('parseArgs — generate-zip is true when flag passed', () => {
	const args = parseArgs(['--version=1.0.0', '--generate-zip']);
	assertEquals(args.generateZip, true);
});

Deno.test('parseArgs — minimal required args', () => {
	const args = parseArgs(['--version=1.0.0']);
	assertEquals(args.version, '1.0.0');
	assertEquals(args.svnUser, undefined);
	assertEquals(args.svnPass, undefined);
	assertEquals(args.readmeAndAssetsOnly, false);
	assertEquals(args.dryRun, false);
});

Deno.test('parseArgs — help flag prints help and exits', () => {
	try {
		parseArgs(['--help']);
		throw new Error('Expected docopt Exit');
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		assertStringIncludes(msg, 'Deploy plugin to WordPress.org');
	}
});

// ─── Unit: shouldDeploy ─────────────────────────────────────────────────────

Deno.test({
	name: 'shouldDeploy — false without .wordpress-org dir',
	async fn() {
		const dir = join(TEST_BASE, `no-org-${uid()}`);
		await Deno.mkdir(dir, { recursive: true });
		try {
			const ctx = makeCtx({ pluginDir: dir, version: '1.0.0' });
			assertEquals(await shouldDeploy(ctx), false);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: 'shouldDeploy — false for alpha version',
	async fn() {
		const dir = join(TEST_BASE, `alpha-${uid()}`);
		await Deno.mkdir(join(dir, '.wordpress-org'), { recursive: true });
		try {
			const ctx = makeCtx({ pluginDir: dir, version: '1.0.0-alpha.1' });
			assertEquals(await shouldDeploy(ctx), false);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: 'shouldDeploy — false for beta version',
	async fn() {
		const dir = join(TEST_BASE, `beta-${uid()}`);
		await Deno.mkdir(join(dir, '.wordpress-org'), { recursive: true });
		try {
			const ctx = makeCtx({ pluginDir: dir, version: '2.0.0-beta.2' });
			assertEquals(await shouldDeploy(ctx), false);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: 'shouldDeploy — false for dev version',
	async fn() {
		const dir = join(TEST_BASE, `dev-${uid()}`);
		await Deno.mkdir(join(dir, '.wordpress-org'), { recursive: true });
		try {
			const ctx = makeCtx({ pluginDir: dir, version: '3.0.0-dev' });
			assertEquals(await shouldDeploy(ctx), false);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: 'shouldDeploy — true with .wordpress-org and stable version',
	async fn() {
		const dir = join(TEST_BASE, `stable-${uid()}`);
		await Deno.mkdir(join(dir, '.wordpress-org'), { recursive: true });
		try {
			const ctx = makeCtx({ pluginDir: dir, version: '1.2.3' });
			assertEquals(await shouldDeploy(ctx), true);
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ─── Unit: getStableTag ─────────────────────────────────────────────────────

Deno.test({
	name: 'getStableTag — reads from readme.txt',
	async fn() {
		const dir = join(TEST_BASE, `readme-${uid()}`);
		await Deno.mkdir(dir, { recursive: true });
		try {
			await Deno.writeTextFile(
				join(dir, 'readme.txt'),
				`=== My Plugin ===\nStable tag: 1.2.3\n`
			);
			assertEquals(await getStableTag(join(dir, 'readme.txt')), '1.2.3');
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: 'getStableTag — handles alternative stable tag format',
	async fn() {
		const dir = join(TEST_BASE, `readme2-${uid()}`);
		await Deno.mkdir(dir, { recursive: true });
		try {
			await Deno.writeTextFile(
				join(dir, 'readme.txt'),
				`=== Plugin ===\n* Stable tag: 0.5.0\n`
			);
			assertEquals(await getStableTag(join(dir, 'readme.txt')), '0.5.0');
		} finally {
			await Deno.remove(dir, { recursive: true });
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ─── Unit: buildCtx ─────────────────────────────────────────────────────────

Deno.test({
	name: 'buildCtx — sets correct svnUrl and commitMsg',
	async fn() {
		const args: CliArgs = {
			version: '1.5.0',
			svnUser: undefined,
			svnPass: undefined,
			workdir: undefined,
			buildDirs: [],
			readmeAndAssetsOnly: false,
			verbose: false,
			generateZip: false,
			dryRun: false,
		};
		// buildCtx changes directory and reads git state, so we run it
		// from the tweakmaster checkout (a real git repo)
		const original = Deno.cwd();
		const tweakmaster = '/home/user23/wpdev/packages/tweakmaster';
		Deno.chdir(tweakmaster);
		try {
			const ctx = await buildCtx(args);
			assertEquals(ctx.slug, 'tweakmaster');
			assertEquals(ctx.svnUrl, 'https://plugins.svn.wordpress.org/tweakmaster/');
			assertStringIncludes(ctx.commitMsg, '1.5.0');
			assertEquals(ctx.tmpDir, '/tmp/wp-deploy');
		} finally {
			Deno.chdir(original);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

Deno.test({
	name: 'buildCtx — readmeOnly mode uses placeholder version',
	async fn() {
		const args: CliArgs = {
			version: undefined,
			svnUser: undefined,
			svnPass: undefined,
			workdir: undefined,
			buildDirs: [],
			readmeAndAssetsOnly: true,
			verbose: false,
			generateZip: false,
			dryRun: false,
		};
		const original = Deno.cwd();
		const tweakmaster = '/home/user23/wpdev/packages/tweakmaster';
		Deno.chdir(tweakmaster);
		try {
			const ctx = await buildCtx(args);
			assertEquals(ctx.version, '0.0.0');
			assertStringIncludes(ctx.commitMsg, 'Update readme and assets');
		} finally {
			Deno.chdir(original);
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ─── Integration: prepareFiles ──────────────────────────────────────────────

Deno.test({
	name: 'prepareFiles — extracts from git archive',
	async fn() {
		const testDir = join(TEST_BASE, `prepfiles-${uid()}`);
		const repoDir = join(testDir, 'repo');
		const target = join(testDir, 'target');
		await Deno.mkdir(target, { recursive: true });

		// Create a minimal git repo with a composer.json that has no real deps
		await Deno.mkdir(repoDir, { recursive: true });
		await Deno.writeTextFile(join(repoDir, 'plugin.php'), '<?php\n');
		await Deno.writeTextFile(join(repoDir, 'readme.txt'), 'readme');
		await Deno.writeTextFile(
			join(repoDir, 'composer.json'),
			JSON.stringify({ require: { php: '>=8.0' } })
		);

		const original = Deno.cwd();
		Deno.chdir(repoDir);
		try {
			await $`git init`;
			await $`git add --all`;
			await $`git commit --message init --no-gpg-sign`;

			const ctx = makeCtx({
				pluginDir: repoDir,
				gitTopLevel: repoDir,
				subdir: '',
				version: 'HEAD',
			});

			await prepareFiles(ctx, target);

			// Should have extracted the plugin file
			assertEquals(await exists(join(target, 'plugin.php')), true);
			assertEquals(await exists(join(target, 'readme.txt')), true);
			// composer.json should exist but composer install should have been skipped (php-only dep)
			assertEquals(await exists(join(target, 'composer.json')), true);
		} finally {
			Deno.chdir(original);
			await Deno.remove(testDir, { recursive: true }).catch(() => {});
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ─── Integration: generateZip ───────────────────────────────────────────────

Deno.test({
	name: 'generateZip — creates zip with correct structure',
	async fn() {
		const tmpDir = join(TEST_BASE, `zip-${uid()}`);
		const sourceDir = join(tmpDir, 'source');
		await Deno.mkdir(sourceDir, { recursive: true });
		await Deno.writeTextFile(join(sourceDir, 'plugin.php'), '<?php');
		await Deno.writeTextFile(join(sourceDir, 'readme.txt'), 'readme');

		const ctx = makeCtx({
			slug: 'test-plugin',
			tmpDir,
			generateZip: true,
			pluginDir: tmpDir,
		});

		try {
			await generateZip(ctx, sourceDir);

			const zipPath = join(tmpDir, 'dist', 'test-plugin.zip');
			assertEquals(await exists(zipPath), true);

			// Verify zip contents using unzip -l
			const listing = await $`unzip -l ${zipPath}`.text();
			assertStringIncludes(listing, 'test-plugin/plugin.php');
			assertStringIncludes(listing, 'test-plugin/readme.txt');
		} finally {
			await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ─── Integration: zip-only path (pre-release tag) ───────────────────────────

Deno.test({
	name: 'integration — zip-only path for pre-release tag',
	async fn() {
		const testDir = join(TEST_BASE, `int-zip-${uid()}`);
		const repoDir = join(testDir, 'my-plugin');
		await Deno.mkdir(repoDir, { recursive: true });

		// Create a minimal git repo with an alpha tag so shouldDeploy returns false
		await Deno.writeTextFile(join(repoDir, 'my-plugin.php'), '<?php\n');
		await Deno.writeTextFile(join(repoDir, 'readme.txt'), 'readme');
		await Deno.writeTextFile(
			join(repoDir, 'composer.json'),
			JSON.stringify({ require: { php: '>=8.0' } })
		);

		const original = Deno.cwd();
		Deno.chdir(repoDir);
		try {
			await $`git init`;
			await $`git add --all`;
			await $`git commit --message init --no-gpg-sign`;
			await $`git tag 1.0.0-alpha.1`;

			const args = parseArgs(['--version=1.0.0-alpha.1', '--generate-zip']);

			const ctx = await buildCtx(args);
			// Isolate temp dir to our test dir
			ctx.tmpDir = join(testDir, 'tmp');
			ctx.gitarchDir = join(ctx.tmpDir, 'git-archive-my-plugin');
			// Set pluginDir to repoDir since workdir is not set
			ctx.pluginDir = repoDir;
			ctx.slug = 'my-plugin';
			ctx.gitTopLevel = repoDir;
			ctx.subdir = '';

			await run(ctx);

			// Zip should exist
			const zipPath = join(repoDir, 'dist', 'my-plugin.zip');
			assertEquals(await exists(zipPath), true, 'zip should exist for pre-release');

			// SVN checkout should NOT exist
			assertEquals(
				await exists(ctx.svnDir),
				false,
				'SVN checkout should not exist for pre-release'
			);

			// Verify zip has proper structure
			const listing = await $`unzip -l ${zipPath}`.text();
			assertStringIncludes(listing, 'my-plugin/my-plugin.php');
		} finally {
			Deno.chdir(original);
			await Deno.remove(testDir, { recursive: true }).catch(() => {});
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});

// ─── Integration: full SVN dry-run (stable tag) ─────────────────────────────

Deno.test({
	name: 'integration — full SVN dry-run with stable tag',
	ignore: !(await hasSvn()) || !shouldRunSvnTests(),
	async fn() {
		const testDir = join(TEST_BASE, `int-svn-${uid()}`);
		const repoDir = join(testDir, 'tweakmaster');
		await Deno.mkdir(testDir, { recursive: true });

		// Clone the real tweakmaster repo at the stable 1.1.2 tag
		const realRepo = '/home/user23/wpdev/packages/tweakmaster';
		await $`git clone ${realRepo} ${repoDir}`;
		await $`git checkout 1.1.2`.cwd(repoDir);

		// Replace composer.json with minimal deps so composer install is skipped
		await Deno.writeTextFile(
			join(repoDir, 'composer.json'),
			JSON.stringify({ require: { php: '>=8.0' } })
		);
		await $`git add composer.json`.cwd(repoDir);
		await $`git commit --message "test: minimal composer" --no-gpg-sign`.cwd(repoDir);

		try {
			const original = Deno.cwd();
			Deno.chdir(repoDir);
			try {
				const args = parseArgs([
					'--version=HEAD',
					'--generate-zip',
					'--dry-run',
					'--verbose',
				]);

				const ctx = await buildCtx(args);
				ctx.tmpDir = join(testDir, 'tmp');
				ctx.svnDir = join(ctx.tmpDir, `svn-${ctx.slug}`);
				ctx.gitarchDir = join(ctx.tmpDir, `git-archive-${ctx.slug}`);

				await run(ctx);

				// In dry-run mode, zip is not created (exits before generateZip)
				// The SVN checkout should exist and have the prepared files
				assertEquals(await exists(ctx.svnDir), true, 'SVN checkout should exist');
				assertEquals(
					await exists(join(ctx.svnDir, 'trunk')),
					true,
					'SVN trunk should exist'
				);
				assertEquals(
					await exists(join(ctx.svnDir, 'assets')),
					true,
					'SVN assets should exist'
				);

				// Verify prepared files are in the SVN trunk
				assertEquals(
					await exists(join(ctx.svnDir, 'trunk', 'tweakmaster.php')),
					true,
					'plugin file should be in SVN trunk'
				);

				// Tag should have been copied
				assertEquals(
					await exists(join(ctx.svnDir, 'tags', 'HEAD')),
					true,
					'tag should be copied'
				);

				// Screenshot mime types should be set
				const pngProps = await $`svn propget svn:mime-type assets/org.png`
					.cwd(ctx.svnDir)
					.text();
				assertStringIncludes(pngProps, 'image/png');
			} finally {
				Deno.chdir(original);
			}
		} finally {
			await Deno.remove(testDir, { recursive: true }).catch(() => {});
		}
	},
	sanitizeResources: false,
	sanitizeOps: false,
});
