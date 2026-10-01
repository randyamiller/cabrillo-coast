#!/usr/bin/env node
/* Cabrillo Coast LLC — article publishing tool (Node built-ins only) */
/**
 * The blog's private publishing workflow, run by authors, by the git hooks in
 * `.githooks/` and by `tests/unit/article-cli.test.mjs`.
 *
 *   node scripts/article.mjs new <slug>        start a draft from _templates/article.md
 *   node scripts/article.mjs check [files…]    check drafts and posts (default: all of them)
 *   node scripts/article.mjs publish <slug>    _drafts/<slug>.md → _posts/<UTC date>-<slug>.md
 *   node scripts/article.mjs unpublish <slug>  the reverse, refused while other articles link to it
 *   node scripts/article.mjs guard --staged    pre-commit: refuse drafts and rule breaks in the index
 *   node scripts/article.mjs guard --pre-push  pre-push: the same for every commit being pushed
 *
 * `--root <dir>` (anywhere on the command line) names the repository root and
 * defaults to the current directory.
 *
 * Why it exists: the repository is public, so a draft is private only while
 * it stays out of git. Drafts live in the git-ignored `_drafts/` and
 * `assets/drafts/` folders, and `guard` is the last local safeguard before
 * the remote: GitHub cannot refuse paths on push for a public repository.
 * These safeguards can be bypassed (`--no-verify`, `git add -f`, a clone
 * without `core.hooksPath`); the README states that residual risk.
 *
 * Division of labour: every article rule (schema, dates, images, unsafe
 * markup, Liquid in code, inbound references, tracked-content rules) lives in
 * `./lib/articles.mjs`, so commit time, push time and test time apply
 * identical checks. This file only reads and moves files, runs git plumbing
 * and reports.
 *
 * Git safety: the tool never changes git state. Only `new` and `guard` run
 * git, and only read-only commands (`config --get`, `ls-files`, `diff`,
 * `rev-parse`, `hash-object` without `-w`, `cat-file`, `rev-list`, `ls-tree`,
 * `diff-tree`), spawned without a shell and with `GIT_OPTIONAL_LOCKS=0` so
 * not even an opportunistic index refresh is written.
 *
 * Exit codes: 0 success, 1 validation failure (details on stderr), 2 usage
 * error. Unwrapped Liquid inside code is a warning and never changes the
 * exit code. `guard` fails closed: any git error refuses the commit or push.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import {
  SLUG_RE,
  SLUG_MAX,
  ARTICLE_PATH_RE,
  parseArticle,
  validateArticle,
  scanUnsafeMarkup,
  findUnrawLiquidInCode,
  findInboundReferences,
  checkTrackedContent,
} from './lib/articles.mjs';

/* ------------------------------------------------------------------------ */
/* Constants                                                                 */
/* ------------------------------------------------------------------------ */

const EXIT_OK = 0;
const EXIT_INVALID = 1;
const EXIT_USAGE = 2;

/** Post filenames: `YYYY-MM-DD-<slug>.md`. Groups: 1 date, 2 slug. */
const POST_FILE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;

/** An object id as git prints it: SHA-1 (40 hex digits) or SHA-256 (64). */
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The all-zero id git uses for "no object" (a new branch, or a deletion). */
const ZERO_ID_RE = /^0+$/;

/** Index and tree mode of an executable file; hooks must carry it. */
const EXECUTABLE_MODE = '100755';

/** Index and tree mode of a submodule (gitlink), which can never be an article. */
const GITLINK_MODE = '160000';

const GIT_MAX_BUFFER = 256 * 1024 * 1024;

const COMMANDS = new Set(['new', 'check', 'publish', 'unpublish', 'guard']);
const GUARD_MODES = new Set(['--staged', '--pre-push']);

const USAGE = `Usage: node scripts/article.mjs <command> [arguments] [--root <dir>]

Commands:
  new <slug>          Create _drafts/<slug>.md from _templates/article.md, plus
                      assets/drafts/<slug>/ for its images
  check [files...]    Check articles (default: every _drafts/ and _posts/ article)
  publish <slug>      Check the draft, move it to _posts/<UTC date>-<slug>.md and
                      its images to assets/blog/<slug>/
  unpublish <slug>    Move a published article and its images back to the drafts
                      folders; refused while other articles still link to it
  guard --staged      Refuse a commit whose staged tree breaks the content rules
                      (run by .githooks/pre-commit)
  guard --pre-push    Refuse a push whose commits break the content rules; reads
                      git's ref lines on stdin (run by .githooks/pre-push)

Options:
  --root <dir>        Repository root (default: the current directory)
  -h, --help          Show this help

Slugs: lowercase letters and digits in groups joined by single hyphens, at most
${SLUG_MAX} characters, e.g. kubernetes-upgrade-notes.

Exit codes: 0 success, 1 validation failure, 2 usage error.
`;

/* ------------------------------------------------------------------------ */
/* Errors and messages                                                       */
/* ------------------------------------------------------------------------ */

/** A command-line mistake: reported with the usage block, exit code 2. */
class UsageError extends Error {}

/** A git command that failed; `guard` treats it as a refusal (fail closed). */
class GitError extends Error {}

/** Progress and next-step commands go to stdout. */
function say(message = '') {
  process.stdout.write(`${message}\n`);
}

/** Findings and failures go to stderr, prefixed `error: `. */
function fail(message) {
  process.stderr.write(`error: ${message}\n`);
}

/** Advisory findings go to stderr, prefixed `warning: `; they never change the exit code. */
function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

/** `1 problem`, `2 problems`. */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Quotes a commit message for the printed next-step command so that copying
 * it into a POSIX shell is safe whatever the article title contains.
 */
function shellQuote(text) {
  if (/^[^"$`\\!]*$/.test(text)) return `"${text}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/* ------------------------------------------------------------------------ */
/* Dates, slugs and paths                                                    */
/* ------------------------------------------------------------------------ */

/** Today's date in UTC as `YYYY-MM-DD`; the site reads filename dates as UTC (`timezone: Etc/UTC`). */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/** A slug that `new`, `publish` and `unpublish` accept: `SLUG_RE` and at most `SLUG_MAX` characters. */
function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && slug.length <= SLUG_MAX;
}

/** Reports an invalid slug with the rule it breaks; returns exit code 1. */
function refuseSlug(slug) {
  fail(`invalid slug ${JSON.stringify(slug)}: use lowercase letters and digits in groups joined by single `
    + `hyphens (${SLUG_RE.source}), at most ${SLUG_MAX} characters`);
  return EXIT_INVALID;
}

/** A native path as a POSIX path (forward slashes), for messages and lib calls. */
function toPosix(nativePath) {
  return nativePath.split(path.sep).join('/');
}

/** Absolute native path of a repository-relative POSIX path. */
function inRoot(root, relPath) {
  return path.join(root, ...relPath.split('/'));
}

/**
 * `fs.lstatSync` or `fs.statSync` that returns `undefined` for a path that
 * cannot exist: missing, below a file (`ENOTDIR`) or, when following links,
 * a symbolic-link loop (`ELOOP`). Other errors, such as `EACCES`, are thrown.
 */
function statOrUndefined(absPath, follow) {
  try {
    return (follow ? fs.statSync : fs.lstatSync)(absPath, { throwIfNoEntry: false });
  } catch (err) {
    if (err.code === 'ENOTDIR' || err.code === 'ELOOP' || err.code === 'ENAMETOOLONG') return undefined;
    throw err;
  }
}

/** True when anything (a file, folder or symbolic link, even a dangling one) exists at `absPath`. */
function pathExists(absPath) {
  return statOrUndefined(absPath, false) !== undefined;
}

/** True when `absPath` is a regular file (symbolic links followed). */
function isFile(absPath) {
  const stat = statOrUndefined(absPath, true);
  return stat !== undefined && stat.isFile();
}

/** True when `absPath` is a real folder: not a file, and not a symbolic link to a folder. */
function isRealDirectory(absPath) {
  const stat = statOrUndefined(absPath, false);
  return stat !== undefined && stat.isDirectory();
}

/** True when the folder holds at least one entry other than a folder, searching recursively. */
function containsFiles(absDir) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return true;
    if (containsFiles(path.join(absDir, entry.name))) return true;
  }
  return false;
}

/**
 * Every `*.md` regular file under `folder` (repository-relative), searched
 * recursively, as sorted repository-relative POSIX paths. A missing folder
 * yields `[]`.
 */
function listMarkdown(root, folder) {
  const found = [];
  const visit = (relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(inRoot(root, relDir), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(child);
    }
  };
  visit(folder);
  return found;
}

/** Posts under `_posts/` (recursively) whose filename is `<date>-<slug>.md`. */
function findPosts(root, slug) {
  return listMarkdown(root, '_posts').filter((rel) => {
    const m = POST_FILE_RE.exec(path.posix.basename(rel));
    return m !== null && m[2] === slug;
  });
}

/** Drafts under `_drafts/` (recursively) named `<slug>.md`. */
function findDrafts(root, slug) {
  return listMarkdown(root, '_drafts').filter((rel) => path.posix.basename(rel) === `${slug}.md`);
}

/**
 * `imageExists` for `validateArticle`: maps a root-relative public path such
 * as `/assets/drafts/foo/fig.png` to the file `<root>/assets/drafts/foo/fig.png`.
 * A path with `.`, `..` or empty segments, or one that would resolve outside
 * the root, never exists; neither does a folder.
 */
function makeImageExists(root) {
  return (publicPath) => {
    if (typeof publicPath !== 'string' || !publicPath.startsWith('/') || publicPath.includes('\0')) return false;
    const segments = publicPath.slice(1).split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
    const target = path.join(root, ...segments);
    const relative = path.relative(root, target);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return false;
    }
    try {
      return isFile(target);
    } catch {
      return false;
    }
  };
}

/* ------------------------------------------------------------------------ */
/* Article checks on disk                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Slug uniqueness across `_posts/` and `_drafts/`: two articles with one slug
 * would publish to the same `/blog/<slug>/` URL and one would vanish.
 */
function slugConflicts(root, relPath, kind) {
  const base = path.posix.basename(relPath);
  const self = path.resolve(inRoot(root, relPath));
  const isOther = (rel) => path.resolve(inRoot(root, rel)) !== self;
  const errors = [];
  if (kind === 'draft') {
    if (!base.endsWith('.md')) return errors;
    const slug = base.slice(0, -'.md'.length);
    for (const post of findPosts(root, slug)) {
      errors.push(`${relPath}: slug ${slug} is already used by the published ${post}`);
    }
    for (const draft of findDrafts(root, slug).filter(isOther)) {
      errors.push(`${relPath}: slug ${slug} is also used by the draft ${draft}`);
    }
    return errors;
  }
  const m = POST_FILE_RE.exec(base);
  if (m === null) return errors;
  const slug = m[2];
  for (const draft of findDrafts(root, slug).filter(isOther)) {
    errors.push(`${relPath}: slug ${slug} is also used by the draft ${draft}`);
  }
  for (const post of findPosts(root, slug).filter(isOther)) {
    errors.push(`${relPath}: slug ${slug} is already used by ${post}; both would publish to /blog/${slug}/`);
  }
  return errors;
}

/**
 * Runs the full article check on one file on disk.
 *
 * Parse errors, `validateArticle` (schema, dates, `TODO:` markers, images
 * resolved against the working tree), slug uniqueness and `scanUnsafeMarkup`
 * are errors; `findUnrawLiquidInCode` findings are warnings. Every message
 * starts with `relPath` and body findings carry their file line.
 *
 * @param {string} root Absolute repository root.
 * @param {string} relPath Repository-relative POSIX path of the article.
 * @param {'draft' | 'post'} kind Which folder rules apply.
 * @param {string} [today] Today as `YYYY-MM-DD` in UTC, read once per command.
 * @returns {{ errors: string[], warnings: string[], text: string, data: Record<string, unknown> }}
 */
function checkFile(root, relPath, kind, today = todayUtc()) {
  const errors = [];
  const warnings = [];
  let text;
  try {
    text = fs.readFileSync(inRoot(root, relPath), 'utf8');
  } catch (err) {
    errors.push(`${relPath}: cannot read the file (${err.code ?? err.message})`);
    return { errors, warnings, text: '', data: {} };
  }
  const { data, body, errors: parseErrors } = parseArticle(text);
  for (const message of parseErrors) errors.push(`${relPath}: ${message}`);
  // The body is the exact suffix of the text, so this is the file line on which it starts.
  const bodyStartLine = text.slice(0, text.length - body.length).split('\n').length;
  errors.push(...validateArticle({
    path: relPath,
    data,
    body,
    kind,
    todayUtc: today,
    imageExists: makeImageExists(root),
    bodyStartLine,
  }));
  errors.push(...slugConflicts(root, relPath, kind));
  for (const finding of scanUnsafeMarkup(body)) {
    errors.push(`${relPath}:${bodyStartLine + finding.line - 1}: unsafe markup "${finding.text}"`);
  }
  for (const finding of findUnrawLiquidInCode(body)) {
    warnings.push(`${relPath}:${bodyStartLine + finding.line - 1}: Liquid syntax inside code; `
      + 'wrap it in {% raw %}…{% endraw %}');
  }
  return { errors, warnings, text, data };
}

/**
 * Kind of an explicitly named file: a draft when its folder is `_drafts`, or
 * when it sits anywhere under `<root>/_drafts/` (as the default listing finds
 * drafts recursively); otherwise a post, and `validateArticle` reports a
 * filename that does not match `YYYY-MM-DD-<slug>.md`.
 */
function kindOf(root, absFile) {
  if (path.basename(path.dirname(absFile)) === '_drafts') return 'draft';
  const relative = path.relative(root, absFile);
  return relative.split(path.sep)[0] === '_drafts' ? 'draft' : 'post';
}

/* ------------------------------------------------------------------------ */
/* Git plumbing (read-only)                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Runs one git command without a shell. Arguments are passed as an array, so
 * no path or ref is ever interpolated into a command string.
 * `GIT_OPTIONAL_LOCKS=0` stops git writing even an opportunistic index
 * refresh, so these commands leave the repository exactly as they found it.
 * The inherited environment is otherwise kept: inside a hook it carries
 * `GIT_INDEX_FILE`, which points `git commit -a` and partial commits at the
 * index actually being committed.
 *
 * @returns {{ ok: boolean, stdout: Buffer, stderr: string, detail: string }}
 */
function runGit(cwd, args, input) {
  const options = {
    cwd,
    encoding: 'buffer',
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  };
  if (input !== undefined) options.input = input;
  const result = spawnSync('git', args, options);
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
  const ok = result.error === undefined && result.status === 0;
  let detail = '';
  if (!ok) {
    if (result.error) detail = result.error.code === 'ENOENT' ? 'git is not installed or not on PATH' : result.error.message;
    else if (result.signal) detail = `terminated by ${result.signal}`;
    else detail = stderr || `exit status ${result.status}`;
  }
  return { ok, stdout, stderr, detail };
}

/** Runs a git command and returns its stdout, or throws `GitError` naming the command. */
function git(cwd, args, input) {
  const result = runGit(cwd, args, input);
  if (!result.ok) throw new GitError(`git ${args.join(' ')} failed: ${result.detail}`);
  return result.stdout;
}

/** Splits `-z` output into its NUL-terminated records, decoded as UTF-8. */
function splitNul(buffer) {
  return buffer.toString('utf8').split('\0').filter((record) => record !== '');
}

/** Splits line-oriented output into its non-empty lines. */
function splitLines(buffer) {
  return buffer.toString('utf8').split(/\r?\n/).filter((line) => line !== '');
}

/**
 * The working-tree root of the repository containing `root`. Guard runs every
 * other git command there: `git ls-files` lists only the current folder's
 * subtree, so running it from a subfolder would hide drafts elsewhere.
 */
function gitToplevel(root) {
  const top = git(root, ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\r?\n$/, '');
  if (top === '') throw new GitError(`git rev-parse --show-toplevel found no working tree for ${root}`);
  return top;
}

/**
 * Reads a blob's exact bytes by object id and decodes them as UTF-8, caching
 * by id so a blob shared by several commits is read once. Reading by id with
 * `cat-file blob` returns the stored content with no textconv or filter
 * applied, so the checks always see exactly what would be published.
 */
function makeBlobReader(cwd) {
  const cache = new Map();
  return (oid) => {
    if (!cache.has(oid)) cache.set(oid, git(cwd, ['cat-file', 'blob', oid]).toString('utf8'));
    return cache.get(oid);
  };
}

/* ------------------------------------------------------------------------ */
/* new <slug>                                                                */
/* ------------------------------------------------------------------------ */

/**
 * True when `core.hooksPath` points at this clone's `.githooks/`. Git resolves
 * a relative value against the working-tree root, so `.githooks`,
 * `./.githooks` and the absolute path are all accepted.
 */
function hooksEnabled(root) {
  const result = runGit(root, ['config', '--get', 'core.hooksPath']);
  if (!result.ok) return false;
  const value = result.stdout.toString('utf8').trim();
  return value !== '' && path.resolve(root, value) === path.resolve(root, '.githooks');
}

function cmdNew(root, slug) {
  if (!isValidSlug(slug)) return refuseSlug(slug);
  const draftRel = `_drafts/${slug}.md`;
  const used = [...findDrafts(root, slug), ...findPosts(root, slug)];
  if (pathExists(inRoot(root, draftRel)) && !used.includes(draftRel)) used.unshift(draftRel);
  if (used.length > 0) {
    fail(`slug ${slug} is already used by ${used.join(', ')}; choose another slug`);
    return EXIT_INVALID;
  }

  let template;
  try {
    template = fs.readFileSync(inRoot(root, '_templates/article.md'));
  } catch (err) {
    fail(`cannot read _templates/article.md under ${root} (${err.code ?? err.message})`);
    return EXIT_INVALID;
  }

  fs.mkdirSync(inRoot(root, '_drafts'), { recursive: true });
  try {
    // 'wx' never overwrites: a draft created since the check above is kept.
    fs.writeFileSync(inRoot(root, draftRel), template, { flag: 'wx' });
  } catch (err) {
    fail(err.code === 'EEXIST' ? `${draftRel} already exists` : `cannot write ${draftRel} (${err.message})`);
    return EXIT_INVALID;
  }
  fs.mkdirSync(inRoot(root, `assets/drafts/${slug}`), { recursive: true });

  say(`Created ${draftRel} from _templates/article.md, and assets/drafts/${slug}/ for its images.`);
  say('Both folders are git-ignored: the draft stays on this machine until you publish it.');
  if (!hooksEnabled(root)) {
    warn('git hooks are not enabled for this clone; run: git config core.hooksPath .githooks');
  }
  say();
  say('Next:');
  say(`  1. Edit ${draftRel}. Put images in assets/drafts/${slug}/ and reference them as`);
  say(`     {{ '/assets/drafts/${slug}/figure.png' | relative_url }}`);
  say('  2. Preview: bundle exec jekyll serve --drafts --config _config.yml,_config.preview.yml');
  say(`     then open http://localhost:4000/blog/${slug}/`);
  say(`  3. node scripts/article.mjs check ${draftRel}`);
  say(`  4. node scripts/article.mjs publish ${slug}`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* check [files…]                                                            */
/* ------------------------------------------------------------------------ */

/** The files `check` was given, resolved against the working directory; missing files are usage errors. */
function resolveCheckTargets(root, files) {
  const targets = [];
  const seen = new Set();
  for (const file of files) {
    const absFile = path.resolve(process.cwd(), file);
    if (!isFile(absFile)) {
      throw new UsageError(`${file}: no such file`);
    }
    const rel = toPosix(path.relative(root, absFile));
    if (seen.has(rel)) continue;
    seen.add(rel);
    targets.push({ rel, kind: kindOf(root, absFile) });
  }
  return targets;
}

function cmdCheck(root, files) {
  const targets = files.length > 0
    ? resolveCheckTargets(root, files)
    : [
      ...listMarkdown(root, '_drafts').map((rel) => ({ rel, kind: 'draft' })),
      ...listMarkdown(root, '_posts').map((rel) => ({ rel, kind: 'post' })),
    ];
  if (targets.length === 0) {
    say('No articles to check.');
    return EXIT_OK;
  }

  const today = todayUtc();
  let withErrors = 0;
  let warningCount = 0;
  for (const { rel, kind } of targets) {
    const { errors, warnings } = checkFile(root, rel, kind, today);
    for (const message of warnings) warn(message);
    warningCount += warnings.length;
    if (errors.length > 0) {
      withErrors += 1;
      for (const message of errors) fail(message);
    } else {
      say(`ok ${rel}`);
    }
  }
  say(`${targets.length} checked, ${withErrors} with errors, ${plural(warningCount, 'warning')}`);
  return withErrors > 0 ? EXIT_INVALID : EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* publish <slug>                                                            */
/* ------------------------------------------------------------------------ */

/** Replaces every occurrence of `from` with `to`. */
function replaceAllText(text, from, to) {
  return text.split(from).join(to);
}

/**
 * Writes `target` without ever overwriting it: the rewritten text when there
 * is one, otherwise a byte-for-byte copy of `source`.
 */
function writeExclusive(source, target, rewritten) {
  if (rewritten === null) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  else fs.writeFileSync(target, rewritten, { encoding: 'utf8', flag: 'wx' });
}

function cmdPublish(root, slug) {
  if (!isValidSlug(slug)) return refuseSlug(slug);
  const today = todayUtc();
  const draftRel = `_drafts/${slug}.md`;
  const draftAbs = inRoot(root, draftRel);
  if (!isFile(draftAbs)) {
    fail(`${draftRel} does not exist; start a draft with: node scripts/article.mjs new ${slug}`);
    return EXIT_INVALID;
  }

  const { errors, warnings, text, data } = checkFile(root, draftRel, 'draft', today);
  for (const message of warnings) warn(message);
  if (errors.length > 0) {
    for (const message of errors) fail(message);
    fail(`publish refused (${plural(errors.length, 'problem')}); nothing was moved`);
    return EXIT_INVALID;
  }

  const postFile = `${today}-${slug}.md`;
  const postRel = `_posts/${postFile}`;
  const postAbs = inRoot(root, postRel);
  if (pathExists(postAbs)) {
    fail(`${postRel} already exists; nothing was moved`);
    return EXIT_INVALID;
  }

  const draftImagesRel = `assets/drafts/${slug}`;
  const blogImagesRel = `assets/blog/${slug}`;
  const draftImagesAbs = inRoot(root, draftImagesRel);
  const blogImagesAbs = inRoot(root, blogImagesRel);
  if (pathExists(draftImagesAbs) && !isRealDirectory(draftImagesAbs)) {
    fail(`${draftImagesRel} is not a folder (or is a symbolic link); replace it with a real folder of images`);
    return EXIT_INVALID;
  }
  const imageFolder = isRealDirectory(draftImagesAbs);
  const moveImages = imageFolder && containsFiles(draftImagesAbs);
  if (moveImages && pathExists(blogImagesAbs)) {
    fail(`${blogImagesRel}/ already exists; move or remove it before publishing; nothing was moved`);
    return EXIT_INVALID;
  }

  // The image paths change only when the folder moves with the article.
  const rewritten = moveImages
    ? replaceAllText(text, `/assets/drafts/${slug}/`, `/assets/blog/${slug}/`)
    : null;

  // Order: write the post, then move the images, then remove the draft. A
  // failure at any step leaves at least one complete copy of the article.
  fs.mkdirSync(inRoot(root, '_posts'), { recursive: true });
  try {
    writeExclusive(draftAbs, postAbs, rewritten);
  } catch (err) {
    fail(`cannot write ${postRel} (${err.code === 'EEXIST' ? 'it already exists' : err.message}); nothing was moved`);
    return EXIT_INVALID;
  }
  try {
    if (moveImages) {
      fs.mkdirSync(inRoot(root, 'assets/blog'), { recursive: true });
      fs.renameSync(draftImagesAbs, blogImagesAbs);
    } else if (imageFolder) {
      // Only empty folders remain inside, so an article without images creates no image folder.
      fs.rmSync(draftImagesAbs, { recursive: true });
    }
  } catch (err) {
    fs.rmSync(postAbs, { force: true });
    fail(`cannot ${moveImages ? `move ${draftImagesRel}/ to ${blogImagesRel}/` : `remove the empty ${draftImagesRel}/`} `
      + `(${err.message}); ${postRel} was removed again and the draft is unchanged`);
    return EXIT_INVALID;
  }
  try {
    fs.unlinkSync(draftAbs);
  } catch (err) {
    fail(`published ${postRel}, but cannot remove ${draftRel} (${err.message}); delete it by hand`);
    return EXIT_INVALID;
  }

  say(`Published ${draftRel} as ${postRel}.`);
  if (moveImages) say(`Moved ${draftImagesRel}/ to ${blogImagesRel}/ and rewrote the image paths.`);
  else if (imageFolder) say(`Removed the empty ${draftImagesRel}/.`);
  const title = typeof data.title === 'string' ? data.title : slug;
  say();
  say('Next:');
  say('  node scripts/verify.mjs');
  say(`  git add ${postRel}${moveImages ? ` ${blogImagesRel}` : ''}`);
  say(`  git commit -m ${shellQuote(`Publish: ${title}`)}`);
  say('  git push origin main');
  say('Once pushed, the article is public and stays in git history, even after unpublishing.');
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* unpublish <slug>                                                          */
/* ------------------------------------------------------------------------ */

function cmdUnpublish(root, slug) {
  if (!isValidSlug(slug)) return refuseSlug(slug);
  const posts = findPosts(root, slug);
  if (posts.length === 0) {
    fail(`no published article with slug ${slug} in _posts/`);
    return EXIT_INVALID;
  }
  if (posts.length > 1) {
    fail(`slug ${slug} is used by more than one post (${posts.join(', ')}); resolve the duplicate first`);
    return EXIT_INVALID;
  }
  const postRel = posts[0];
  const postAbs = inRoot(root, postRel);
  const postStem = path.posix.basename(postRel).slice(0, -'.md'.length);
  const draftRel = `_drafts/${slug}.md`;
  const draftAbs = inRoot(root, draftRel);
  const draftImagesRel = `assets/drafts/${slug}`;
  const blogImagesRel = `assets/blog/${slug}`;
  const draftImagesAbs = inRoot(root, draftImagesRel);
  const blogImagesAbs = inRoot(root, blogImagesRel);
  for (const [rel, abs] of [[draftRel, draftAbs], [`${draftImagesRel}/`, draftImagesAbs]]) {
    if (pathExists(abs)) {
      fail(`${rel} already exists; move it aside so unpublishing overwrites nothing`);
      return EXIT_INVALID;
    }
  }
  if (pathExists(blogImagesAbs) && !isRealDirectory(blogImagesAbs)) {
    fail(`${blogImagesRel} is not a folder (or is a symbolic link); fix it before unpublishing`);
    return EXIT_INVALID;
  }

  // Inbound references: a remaining post_url fails the Pages build (so the old
  // page stays live), and an ordinary link would break.
  const others = listMarkdown(root, '_posts')
    .filter((rel) => rel !== postRel)
    .map((rel) => ({ path: rel, text: fs.readFileSync(inRoot(root, rel), 'utf8') }));
  const references = findInboundReferences(slug, postStem, others);
  if (references.length > 0) {
    fail(`unpublish refused: ${plural(references.length, 'reference')} to ${postRel} `
      + `${references.length === 1 ? 'remains' : 'remain'}:`);
    for (const ref of references) process.stderr.write(`  ${ref.file}:${ref.line}: ${ref.text}\n`);
    fail('a remaining post_url would fail the Pages build and leave the old page live, and an ordinary '
      + 'link would break; repoint or remove these references, then run unpublish again (nothing was moved)');
    return EXIT_INVALID;
  }

  // In a fresh clone an image-free article has no image folder (git keeps no
  // empty folders), so the post moves alone.
  const moveImages = isRealDirectory(blogImagesAbs);
  const rewritten = moveImages
    ? replaceAllText(fs.readFileSync(postAbs, 'utf8'), `/assets/blog/${slug}/`, `/assets/drafts/${slug}/`)
    : null;

  // Order: write the draft, then move the images, then remove the post.
  fs.mkdirSync(inRoot(root, '_drafts'), { recursive: true });
  try {
    writeExclusive(postAbs, draftAbs, rewritten);
  } catch (err) {
    fail(`cannot write ${draftRel} (${err.code === 'EEXIST' ? 'it already exists' : err.message}); nothing was moved`);
    return EXIT_INVALID;
  }
  if (moveImages) {
    try {
      fs.mkdirSync(inRoot(root, 'assets/drafts'), { recursive: true });
      fs.renameSync(blogImagesAbs, draftImagesAbs);
    } catch (err) {
      fs.rmSync(draftAbs, { force: true });
      fail(`cannot move ${blogImagesRel}/ to ${draftImagesRel}/ (${err.message}); ${draftRel} was removed `
        + 'again and the post is unchanged');
      return EXIT_INVALID;
    }
  }
  try {
    fs.unlinkSync(postAbs);
  } catch (err) {
    fail(`wrote ${draftRel}, but cannot remove ${postRel} (${err.message}); delete it by hand`);
    return EXIT_INVALID;
  }

  say(`Unpublished ${postRel}; it is now the draft ${draftRel}.`);
  if (moveImages) say(`Moved ${blogImagesRel}/ to ${draftImagesRel}/ and rewrote the image paths.`);
  say();
  say('Next:');
  say(`  git add -A -- ${postRel}${moveImages ? ` ${blogImagesRel}` : ''}`);
  say(`  git commit -m "Unpublish: ${slug}"`);
  say('  git push origin main');
  warn('everything already pushed stays readable in git history; unpublishing only removes the article '
    + 'from the live site at the next Pages build');
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* guard --staged                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Parses `git ls-files -s -z`: `<mode> <object> <stage>\t<path>` records.
 * Returns every record, in index order.
 */
function parseIndex(buffer) {
  return splitNul(buffer).map((record) => {
    const tab = record.indexOf('\t');
    const [mode, oid, stage] = record.slice(0, tab).split(' ');
    if (tab <= 0 || !OBJECT_ID_RE.test(oid ?? '')) throw new GitError(`unexpected git ls-files record: ${record}`);
    return { mode, oid, stage, path: record.slice(tab + 1) };
  });
}

/**
 * Paths the commit adds, copies, modifies or renames. On an unborn branch
 * `git diff --cached` already compares against the empty tree; should a git
 * version refuse it there, the comparison is rerun against the empty tree,
 * computed by `hash-object` without `-w`, so nothing is written.
 */
function stagedChanges(top) {
  const args = ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];
  const first = runGit(top, args);
  if (first.ok) return splitNul(first.stdout);
  if (runGit(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).ok) {
    throw new GitError(`git ${args.join(' ')} failed: ${first.detail}`);
  }
  const emptyTree = git(top, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim();
  return splitNul(git(top, [...args, emptyTree]));
}

/** Reads the given articles from tree or index entries; a submodule in an article path is an error. */
function readArticles(changedPaths, entryFor, readBlob, errors) {
  const articles = [];
  for (const p of changedPaths) {
    if (!ARTICLE_PATH_RE.test(p)) continue;
    const entry = entryFor(p);
    if (entry === undefined) throw new GitError(`${p} is listed as changed but has no entry in the tree`);
    if (entry.mode === GITLINK_MODE) {
      errors.push(`${p}: a submodule cannot be an article`);
      continue;
    }
    articles.push({ path: p, text: readBlob(entry.oid) });
  }
  return articles;
}

function cmdGuardStaged(root) {
  const top = gitToplevel(root);
  const today = todayUtc();
  const records = parseIndex(git(top, ['ls-files', '-s', '-z']));
  const errors = [];

  // The complete staged tree, with the stage-0 entry of each path for reading.
  const paths = [];
  const entries = new Map();
  const hookModeReported = new Set();
  for (const record of records) {
    if (!entries.has(record.path)) paths.push(record.path);
    if (!entries.has(record.path) || record.stage === '0') entries.set(record.path, record);
    if (record.path.startsWith('.githooks/') && record.mode !== EXECUTABLE_MODE && !hookModeReported.has(record.path)) {
      hookModeReported.add(record.path);
      errors.push(`${record.path}: staged with mode ${record.mode}; run git update-index --chmod=+x ${record.path}`);
    }
  }

  const readBlob = makeBlobReader(top);
  const articles = readArticles(stagedChanges(top), (p) => entries.get(p), readBlob, errors);
  errors.push(...checkTrackedContent({ paths, articles, todayUtc: today }));

  if (errors.length > 0) {
    for (const message of errors) fail(message);
    process.stderr.write(`guard: commit refused (${plural(errors.length, 'problem')}). `
      + 'Fix them, or unstage the files.\n');
    return EXIT_INVALID;
  }
  say(`guard: staged tree ok (${plural(articles.length, 'changed article')} checked)`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* guard --pre-push                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Reads all of standard input. Retries when the descriptor is non-blocking
 * and momentarily empty (`EAGAIN`), so a slow writer is never cut short.
 */
function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let count;
    try {
      count = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      if (err.code === 'EOF') break;
      throw err;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses git's pre-push input: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
function parsePushLines(input) {
  const lines = [];
  for (const raw of input.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 4 || !OBJECT_ID_RE.test(fields[1]) || !OBJECT_ID_RE.test(fields[3])) {
      throw new UsageError(`guard --pre-push: malformed input line ${JSON.stringify(line)}; expected `
        + '"<local ref> <local sha> <remote ref> <remote sha>"');
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    lines.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return lines;
}

/**
 * Every commit the push would publish, deduplicated across ref lines. A new
 * branch (zero remote sha), or a remote tip this clone does not have, is
 * checked against everything no remote-tracking ref already holds.
 */
function commitsToPush(top, lines) {
  const commits = [];
  const seen = new Set();
  for (const { localSha, remoteSha } of lines) {
    if (ZERO_ID_RE.test(localSha)) continue; // a branch deletion publishes nothing
    const known = !ZERO_ID_RE.test(remoteSha) && runGit(top, ['cat-file', '-e', `${remoteSha}^{commit}`]).ok;
    const args = known ? ['rev-list', `${remoteSha}..${localSha}`] : ['rev-list', localSha, '--not', '--remotes'];
    for (const commit of splitLines(git(top, args))) {
      if (seen.has(commit)) continue;
      seen.add(commit);
      commits.push(commit);
    }
  }
  return commits;
}

/** Parses `git ls-tree -r -z --full-tree`: `<mode> <type> <object>\t<path>` records, keyed by path. */
function parseTree(buffer) {
  const entries = new Map();
  for (const record of splitNul(buffer)) {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (tab <= 0 || !OBJECT_ID_RE.test(oid ?? '')) throw new GitError(`unexpected git ls-tree record: ${record}`);
    entries.set(record.slice(tab + 1), { mode, type, oid });
  }
  return entries;
}

function cmdGuardPrePush(root) {
  const lines = parsePushLines(readStdin());
  if (lines.length === 0) return EXIT_OK;
  const top = gitToplevel(root);
  const today = todayUtc();
  const commits = commitsToPush(top, lines);
  const readBlob = makeBlobReader(top);

  const problems = [];
  let refusedCommits = 0;
  for (const commit of commits) {
    // The complete tree of every pushed commit, not only the tip: a draft
    // added and later deleted, or an image folder whose post was deleted, is
    // published by the commit that holds it.
    const tree = parseTree(git(top, ['ls-tree', '-r', '-z', '--full-tree', commit]));
    // --root lists a root commit's files; --diff-merges=first-parent lists a merge's changes.
    const changed = splitNul(git(top, [
      'diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '--diff-filter=AM',
      '--diff-merges=first-parent', '-z', commit,
    ]));
    const errors = [];
    const articles = readArticles(changed, (p) => tree.get(p), readBlob, errors);
    errors.push(...checkTrackedContent({ paths: [...tree.keys()], articles, todayUtc: today }));
    if (errors.length > 0) {
      refusedCommits += 1;
      const short = commit.slice(0, 7);
      for (const message of errors) problems.push(`${short}: ${message}`);
    }
  }

  if (problems.length > 0) {
    for (const message of problems) fail(message);
    process.stderr.write(`guard: push refused (${plural(problems.length, 'problem')} in `
      + `${plural(refusedCommits, 'commit')}).\n`);
    return EXIT_INVALID;
  }
  say(`guard: ok (${plural(commits.length, 'commit')} checked)`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* Command line                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Parses the command line. `--root <dir>` (or `--root=<dir>`) may appear
 * anywhere; `--` ends option parsing. The first other token is the command
 * and the rest are its arguments.
 *
 * @returns {{ help: boolean, root: string, command: string, args: string[], modes: string[] }}
 */
function parseArgs(argv) {
  // Help wins over every other token before `--`, mistakes included.
  const optionsEnd = argv.indexOf('--');
  const help = (optionsEnd === -1 ? argv : argv.slice(0, optionsEnd)).some((t) => t === '-h' || t === '--help');
  if (help) return { help, root: '', command: '', args: [], modes: [] };

  const positional = [];
  const modes = [];
  let rootArg = null;
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (optionsEnded || !token.startsWith('-') || token === '-') {
      positional.push(token);
    } else if (token === '--') {
      optionsEnded = true;
    } else if (token === '--root' || token.startsWith('--root=')) {
      let value;
      if (token === '--root') {
        value = argv[i + 1];
        i += 1;
        if (value === undefined || value.startsWith('-')) throw new UsageError('--root needs a directory');
      } else {
        value = token.slice('--root='.length);
      }
      if (value === '') throw new UsageError('--root needs a directory');
      if (rootArg !== null) throw new UsageError('--root given more than once');
      rootArg = value;
    } else if (GUARD_MODES.has(token)) {
      modes.push(token);
    } else {
      throw new UsageError(`unknown option ${token}`);
    }
  }

  const [command, ...args] = positional;
  if (command === undefined) throw new UsageError('no command given');
  if (!COMMANDS.has(command)) throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  if (command !== 'guard' && modes.length > 0) throw new UsageError(`${modes[0]} is only valid with guard`);
  if (command === 'new' || command === 'publish' || command === 'unpublish') {
    if (args.length === 0) throw new UsageError(`${command} needs a <slug>`);
    if (args.length > 1) throw new UsageError(`unexpected arguments for ${command}: ${args.slice(1).join(' ')}`);
  }
  if (command === 'guard') {
    if (args.length > 0) throw new UsageError(`unexpected arguments for guard: ${args.join(' ')}`);
    if (modes.length !== 1) throw new UsageError('guard needs exactly one of --staged or --pre-push');
  }

  const root = path.resolve(rootArg ?? process.cwd());
  const rootStat = fs.statSync(root, { throwIfNoEntry: false });
  if (rootStat === undefined || !rootStat.isDirectory()) throw new UsageError(`--root ${root} is not a directory`);
  return { help, root, command, args, modes };
}

function run(argv) {
  const { help, root, command, args, modes } = parseArgs(argv);
  if (help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  switch (command) {
    case 'new':
      return cmdNew(root, args[0]);
    case 'check':
      return cmdCheck(root, args);
    case 'publish':
      return cmdPublish(root, args[0]);
    case 'unpublish':
      return cmdUnpublish(root, args[0]);
    default:
      return modes[0] === '--staged' ? cmdGuardStaged(root) : cmdGuardPrePush(root);
  }
}

/**
 * Entry point. Usage errors print the usage block and exit 2; every other
 * failure, git errors included, exits 1, so a guard that cannot complete its
 * checks refuses rather than allows. The exit code is set rather than forced
 * so buffered output to a pipe is flushed first.
 */
function main() {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      fail(err.message);
      process.stderr.write(`\n${USAGE}`);
      process.exitCode = EXIT_USAGE;
    } else if (err instanceof GitError) {
      fail(err.message);
      fail('guard could not complete its checks, so it refuses (fail closed)');
      process.exitCode = EXIT_INVALID;
    } else {
      // A system error (it carries a code such as EACCES) is reported by its
      // message; anything else is unexpected, so its stack is kept.
      fail(typeof err?.code === 'string' ? err.message : (err?.stack ?? String(err)));
      process.exitCode = EXIT_INVALID;
    }
  }
}

main();
