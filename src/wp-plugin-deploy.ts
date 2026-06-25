#!/usr/bin/env -S deno run -A

import docopt from 'docopt';
import { $ } from '@david/dax';
import { exists } from '@std/fs';
import { basename, relative, resolve } from '@std/path';

// ─── CLI Args ───────────────────────────────────────────────────────────────

const DOC = `Deploy plugin to WordPress.org SVN and/or generate zip.

Usage:
  wp-plugin-deploy.ts --version=<version> [--svn-user=<user> --svn-pass=<pass>] [options]
  wp-plugin-deploy.ts --readme-and-assets-only [options]
  wp-plugin-deploy.ts -h | --help

Options:
  --version=<version>          Version to deploy.
  --svn-user=<user>            WP.org SVN username.
  --svn-pass=<pass>            WP.org SVN password.
  --workdir=<dir>              Relative path to plugin directory.
  --build-dirs=<dirs>          Comma-separated build directories.
  --readme-and-assets-only     Only update readme and .wordpress-org assets.
  --verbose                    Print commands being run.
  --generate-zip               Generate zip archive.
  --dry-run                    Skip SVN commit.
  -h --help                    Show this screen.
`;

export interface CliArgs {
	version?: string;
	svnUser?: string;
	svnPass?: string;
	workdir?: string;
	buildDirs: string[];
	readmeAndAssetsOnly: boolean;
	verbose: boolean;
	generateZip: boolean;
	dryRun: boolean;
}

export interface Ctx {
	slug: string;
	pluginDir: string;
	gitTopLevel: string;
	subdir: string;
	version: string;
	svnUser?: string;
	svnPass?: string;
	buildDirs: string[];
	readmeOnly: boolean;
	verbose: boolean;
	generateZip: boolean;
	dryRun: boolean;
	tmpDir: string;
	svnUrl: string;
	svnDir: string;
	gitarchDir: string;
	commitMsg: string;
}

export function parseArgs(argv = Deno.args): CliArgs {
	const raw: Record<string, unknown> = docopt(DOC, { argv });

	return {
		version: String(raw['--version'] || '') || undefined,
		svnUser: String(raw['--svn-user'] ?? '') || undefined,
		svnPass: String(raw['--svn-pass'] ?? '') || undefined,
		workdir: String(raw['--workdir'] ?? '') || undefined,
		buildDirs: parseBuildDirs(String(raw['--build-dirs'] ?? '')),
		readmeAndAssetsOnly: Boolean(raw['--readme-and-assets-only']),
		verbose: Boolean(raw['--verbose']),
		generateZip: Boolean(raw['--generate-zip']),
		dryRun: Boolean(raw['--dry-run']),
	};
}

export function parseBuildDirs(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		),
	];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function status(icon: string, msg: string): void {
	console.log(`${icon} ${msg}`);
}

function fail(msg: string): never {
	console.error(`✗ ${msg}`);
	Deno.exit(1);
}

async function readHead(path: string, maxBytes = 4096): Promise<string> {
	const file = await Deno.open(path, { read: true });
	const buf = new Uint8Array(maxBytes);
	const n = await file.read(buf);
	file.close();
	return new TextDecoder().decode(buf.subarray(0, n ?? 0));
}

// ─── Setup / paths ──────────────────────────────────────────────────────────

export async function buildCtx(args: CliArgs): Promise<Ctx> {
	const cwd = Deno.cwd();
	const pluginDir = args.workdir ? resolve(cwd, args.workdir) : cwd;
	Deno.chdir(pluginDir);

	await fixGitConfig(pluginDir);

	const slug = basename(pluginDir);
	const gitTopLevel = (await $`git rev-parse --show-toplevel`.text()).trim();
	const subdir = gitTopLevel === pluginDir ? '' : relative(gitTopLevel, pluginDir);
	const tmpDir = '/tmp/wp-deploy';

	const readmeOnly = args.readmeAndAssetsOnly;
	let version: string;
	let commitMsg: string;

	if (readmeOnly) {
		version = '0.0.0';
		commitMsg = 'Update readme and assets with NextgenThemes WordPress Plugin Deploy';
	} else {
		version = args.version ?? fail('--version is required unless --readme-and-assets-only');
		commitMsg = `Update plugin to version ${version} with NextgenThemes WordPress Plugin Deploy`;
	}

	return {
		slug,
		pluginDir,
		gitTopLevel,
		subdir,
		version,
		svnUser: args.svnUser,
		svnPass: args.svnPass,
		buildDirs: args.buildDirs,
		readmeOnly,
		verbose: args.verbose,
		generateZip: args.generateZip,
		dryRun: args.dryRun,
		tmpDir,
		svnUrl: `https://plugins.svn.wordpress.org/${slug}/`,
		svnDir: `${tmpDir}/svn-${slug}`,
		gitarchDir: `${tmpDir}/git-archive-${slug}`,
		commitMsg,
	};
}

async function fixGitConfig(cwd: string): Promise<void> {
	if (Deno.env.get('GITHUB_ACTION')) {
		await $`git config --global --add safe.directory ${cwd}`;
	}
}

// ─── Deploy check ───────────────────────────────────────────────────────────

export async function shouldDeploy(ctx: Ctx): Promise<boolean> {
	if (!(await exists(ctx.pluginDir + '/.wordpress-org'))) {
		return false;
	}
	if (/alpha|beta|dev/i.test(ctx.version)) {
		return false;
	}
	return true;
}

// ─── File preparation ───────────────────────────────────────────────────────

export async function prepareFiles(ctx: Ctx, target: string): Promise<void> {
	await Deno.mkdir(target, { recursive: true });

	const ref = ctx.subdir ? `${ctx.version}:${ctx.subdir}` : ctx.version;

	await $`git --git-dir=${ctx.gitTopLevel}/.git archive ${ref} | tar x --directory=${target}`;

	for (const dir of ctx.buildDirs) {
		const src = `${ctx.pluginDir}/${dir}`;
		if (!(await exists(src))) {
			fail(`Build dir ${src} does not exist`);
		}
		await $`rsync -r --checksum --delete ${src}/ ${target}/`;
	}
}

// ─── Zip generation ─────────────────────────────────────────────────────────

export async function generateZip(ctx: Ctx, sourceDir: string): Promise<void> {
	if (!ctx.generateZip) {
		return;
	}

	status('➤', 'Generating zip file...');

	const symlinkPath = `${ctx.tmpDir}/${ctx.slug}`;
	const zipDir = Deno.env.get('GITHUB_WORKSPACE') || ctx.pluginDir;
	const zipPath = `${zipDir}/${ctx.slug}.zip`;

	const cwd = Deno.cwd();
	try {
		await Deno.symlink(sourceDir, symlinkPath);
		Deno.chdir(ctx.tmpDir);
		await $`zip -r ${zipPath} ${ctx.slug}`;
	} finally {
		Deno.chdir(cwd);
		try {
			await Deno.remove(symlinkPath);
		} catch {
			/* ignore */
		}
	}

	const githubOutput = Deno.env.get('GITHUB_OUTPUT');
	if (githubOutput) {
		await Deno.writeTextFile(githubOutput, `zip-path=${zipPath}\n`, { append: true });
	}

	status('✓', `Zip file generated at ${zipPath}`);
}

// ─── Readme ─────────────────────────────────────────────────────────────────

export async function getStableTag(readmeFile: string): Promise<string> {
	if (!(await exists(readmeFile))) {
		fail('No readme.txt found');
	}

	const content = await readHead(readmeFile);
	const match = content.match(/^([*+-]\s+)?Stable tag:\s*(\S+)/m);

	if (!match) {
		fail('No Stable tag found in readme.txt');
	}

	console.log(`Detected Stable tag: ${match[2]}`);
	return match[2];
}

// ─── SVN helpers ────────────────────────────────────────────────────────────

async function svnCheckout(ctx: Ctx): Promise<void> {
	status('➤', 'Checking out wp.org repository...');
	await $`svn checkout --depth immediates ${ctx.svnUrl} ${ctx.svnDir}`;
	Deno.chdir(ctx.svnDir);
	await $`svn update --set-depth infinity assets`;
	await $`svn update --set-depth infinity trunk`;
}

async function svnAddAll(): Promise<void> {
	await $`svn add . --force --quiet`;
}

async function svnRemoveDeleted(): Promise<void> {
	const out = await $`svn status`.text();
	const deleted: string[] = out
		.split('\n')
		.filter((line: string) => line.startsWith('!'))
		.map((line: string) => line.replace(/^!\s*/, '').trim())
		.filter(Boolean);
	for (const file of deleted) {
		await $`svn rm ${file} --quiet`;
	}
}

async function svnCopyTag(ctx: Ctx): Promise<void> {
	status('➤', 'Copying tag...');
	await $`svn cp trunk tags/${ctx.version}`;
}

async function svnSetScreenshotMimeTypes(): Promise<void> {
	const types: [string, string][] = [
		['png', 'image/png'],
		['jpg', 'image/jpeg'],
		['gif', 'image/gif'],
		['svg', 'image/svg+xml'],
	];
	let hasAssets = false;
	try {
		hasAssets = await exists('assets');
	} catch {
		return;
	}
	if (!hasAssets) {
		return;
	}

	for (const [ext, mime] of types) {
		let count = 0;
		try {
			for await (const entry of Deno.readDir('assets')) {
				if (entry.isFile && entry.name.endsWith(`.${ext}`)) {
					count++;
				}
			}
		} catch {
			continue;
		}
		if (count > 0) {
			await $`svn propset svn:mime-type ${mime} assets/*.${ext}`;
		}
	}
}

async function svnCommit(ctx: Ctx): Promise<void> {
	if (ctx.svnUser && ctx.svnPass) {
		await $`svn commit -m ${ctx.commitMsg} --no-auth-cache --non-interactive --username ${ctx.svnUser} --password ${ctx.svnPass}`;
	} else {
		await $`svn commit -m ${ctx.commitMsg}`;
	}
}

// ─── Main flow ──────────────────────────────────────────────────────────────

export async function run(ctx: Ctx): Promise<void> {
	await $`rm -rf ${ctx.tmpDir}`;

	// ── Zip-only path ──
	if (!(await shouldDeploy(ctx))) {
		await prepareFiles(ctx, ctx.gitarchDir);
		await generateZip(ctx, ctx.gitarchDir);
		return;
	}

	// ── Full SVN deploy ──
	await svnCheckout(ctx);
	status('➤', 'Copying files...');

	if (ctx.readmeOnly) {
		const stableTag = await getStableTag(`${ctx.pluginDir}/readme.txt`);
		await $`svn update --set-depth immediates ${ctx.svnDir}/tags/${stableTag}`;
		await Deno.copyFile(
			`${ctx.pluginDir}/readme.txt`,
			`${ctx.svnDir}/tags/${stableTag}/readme.txt`
		);
		await Deno.copyFile(`${ctx.pluginDir}/readme.txt`, `${ctx.svnDir}/trunk/readme.txt`);
	} else {
		await prepareFiles(ctx, `${ctx.svnDir}/trunk`);
	}

	await $`rsync -r --checksum --delete ${ctx.pluginDir}/.wordpress-org/ ${ctx.svnDir}/assets`;

	status('➤', 'Preparing files...');
	await svnAddAll();
	await svnRemoveDeleted();

	if (!ctx.readmeOnly) {
		await svnCopyTag(ctx);
	}

	await svnSetScreenshotMimeTypes();
	await $`svn status`;

	if (ctx.dryRun) {
		status('➤', 'Dry run exit');
		return;
	}

	status('➤', 'Committing files...');
	await svnCommit(ctx);
	await generateZip(ctx, `${ctx.svnDir}/trunk`);
	status('✓', 'Plugin deployed!');
}

// ─── Entry point ────────────────────────────────────────────────────────────

if (import.meta.main) {
	const args = parseArgs();
	const ctx = await buildCtx(args);
	await run(ctx);
}
