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
 * not even an opportunistic index refresh is written. Every git command runs
 * under a one-minute deadline (`DEADLINES.gitQuery` in `./lib/subprocess.mjs`)
 * and is killed with SIGKILL when it exceeds it; `guard` then refuses with
 * exit 1, and `new` warns.
 *
 * Changing files: `new`, `publish` and `unpublish` hold a per-slug lock,
 * `_drafts/.<slug>.lock`, while they change files, and undo every completed
 * step when a later one fails, so a failed run leaves the files as it found
 * them and can simply be run again.
 *
 * Exit codes: 0 success, 1 validation failure (details on stderr), 2 usage
 * error. Unwrapped Liquid inside code is a warning and never changes the
 * exit code. `guard` fails closed: any git error refuses the commit or push.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { DEADLINES, describeResult, runSync } from './lib/subprocess.mjs';
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

/** The article being moved was edited or removed while `publish` or `unpublish` ran; its message says which. */
class SourceChanged extends Error {}

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
 * Quotes a commit message or a folder for the printed next-step commands so
 * that copying them into a POSIX shell is safe whatever the article title or
 * the path contains.
 */
function shellQuote(text) {
  if (/^[^"$`\\!]*$/.test(text)) return `"${text}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * True when the command runs outside the repository root it was given with
 * `--root`, so the printed next steps must first change to it: their paths
 * are repository-relative. A working directory that no longer exists counts
 * as outside.
 */
function runsOutsideRoot(root) {
  try {
    return path.resolve(process.cwd()) !== root;
  } catch {
    return true;
  }
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
  // Empty segments are dropped, as path.join drops empty arguments, so a trailing slash is ignored.
  return path.join(root, relPath.split('/').filter((segment) => segment !== '').join(path.sep));
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
    const target = path.join(root, segments.join(path.sep));
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
 * Runs the full article check on the text of one article.
 *
 * Parse errors, `validateArticle` (schema, dates, leftover template
 * placeholders, images resolved against the working tree), slug uniqueness
 * and `scanUnsafeMarkup` are errors; `findUnrawLiquidInCode` findings are
 * warnings. Every message starts with `relPath` and body findings carry their
 * file line.
 *
 * @param {string} root Absolute repository root.
 * @param {string} relPath Repository-relative POSIX path of the article.
 * @param {'draft' | 'post'} kind Which folder rules apply.
 * @param {string} today Today as `YYYY-MM-DD` in UTC, read once per command.
 * @param {string} text The article's text, as read from `relPath`.
 * @returns {{ errors: string[], warnings: string[], text: string, data: Record<string, unknown> }}
 */
function checkText(root, relPath, kind, today, text) {
  const errors = [];
  const warnings = [];
  const { data, body, errors: parseErrors } = parseArticle(text);
  for (const message of parseErrors) errors.push(`${relPath}: ${message}`);
  // The body is the exact suffix of the text, so this is the file line on which it starts.
  const bodyStartLine = text.slice(0, text.length - body.length).split('\n').length;
  const articleErrors = validateArticle({
    path: relPath,
    data,
    body,
    kind,
    todayUtc: today,
    imageExists: makeImageExists(root),
    bodyStartLine,
  });
  for (const message of articleErrors) errors.push(message);
  for (const message of slugConflicts(root, relPath, kind)) errors.push(message);
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
 * Runs `checkText` on one file on disk; a file that cannot be read is
 * reported as an error.
 *
 * @param {string} root Absolute repository root.
 * @param {string} relPath Repository-relative POSIX path of the article.
 * @param {'draft' | 'post'} kind Which folder rules apply.
 * @param {string} [today] Today as `YYYY-MM-DD` in UTC, read once per command.
 * @returns {{ errors: string[], warnings: string[], text: string, data: Record<string, unknown> }}
 */
function checkFile(root, relPath, kind, today = todayUtc()) {
  let text;
  try {
    text = fs.readFileSync(inRoot(root, relPath), 'utf8');
  } catch (err) {
    const errors = [`${relPath}: cannot read the file (${err.code ?? err.message})`];
    return { errors, warnings: [], text: '', data: {} };
  }
  return checkText(root, relPath, kind, today, text);
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
 * Deadline: every command gets one minute (`DEADLINES.gitQuery`) and is
 * killed with SIGKILL when it exceeds it. A stuck git, filesystem or
 * filesystem monitor cannot ignore that signal, so no commit or push waits
 * longer than that per command.
 *
 * Only a git that exited by itself has answered. One that could not start,
 * was killed by a signal, ran out of time or overflowed the capture limit has
 * not, so this throws instead of returning `ok: false`, which the probes in
 * `guard` would read as "no". `guard` then refuses with exit 1 (fail closed);
 * `new`, whose only git read is advisory, warns instead.
 *
 * @returns {{ ok: boolean, stdout: Buffer, stderr: string, detail: string }}
 *   The exit of a git that ran to its end; when `ok` is false, `detail` is
 *   git's trimmed stderr, or its exit status when stderr is empty.
 * @throws {GitError} naming the command and how it ended, when git did not run to its end.
 */
function runGit(cwd, args, input) {
  const result = runSync('git', args, {
    cwd,
    input,
    encoding: 'buffer',
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    timeoutMs: DEADLINES.gitQuery,
  });
  if (!result.completed) {
    const detail = result.error?.code === 'ENOENT'
      ? 'git is not installed or not on PATH'
      : describeResult(result, GIT_MAX_BUFFER);
    throw new GitError(`git ${args.join(' ')} failed: ${detail}`);
  }
  const stderr = result.stderr.trim();
  const detail = result.ok ? '' : stderr || `exit status ${result.status}`;
  return { ok: result.ok, stdout: result.stdout, stderr, detail };
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
 * applied, so the checks always see exactly what would be published. Each
 * article also carries this id to `checkTrackedContent`, which caches the
 * blob's parse and text analysis under it (`guard --pre-push` shares one
 * cache across all its commits), so such a blob is also parsed once.
 */
function makeBlobReader(cwd) {
  const cache = new Map();
  return (oid) => {
    if (!cache.has(oid)) cache.set(oid, git(cwd, ['cat-file', 'blob', oid]).toString('utf8'));
    return cache.get(oid);
  };
}

/* ------------------------------------------------------------------------ */
/* File transactions (new, publish, unpublish)                               */
/* ------------------------------------------------------------------------ */

/**
 * Creates `absPath` holding exactly `bytes`, never overwriting anything:
 * opening with `wx` fails with `EEXIST` when the path is taken, and then this
 * call created nothing and removes nothing. When a write or the close fails,
 * the partial file this call created is removed again, so a retry is not
 * refused by a leftover. The original error is rethrown; a failure to close
 * or remove the partial file is attached to it as `cleanupErrors`.
 *
 * @param {string} absPath Absolute path of the file to create.
 * @param {Buffer} bytes Its complete content.
 */
function createExclusive(absPath, bytes) {
  const fd = fs.openSync(absPath, 'wx');
  let open = true;
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) {
        throw Object.assign(new Error(`EIO: write made no progress, write '${absPath}'`), { code: 'EIO' });
      }
      written += count;
    }
    // Closed once only, even when closing fails: the descriptor is released either way.
    open = false;
    fs.closeSync(fd);
  } catch (err) {
    const cleanupErrors = [];
    if (open) {
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        cleanupErrors.push(closeErr);
      }
    }
    try {
      fs.unlinkSync(absPath);
    } catch (unlinkErr) {
      if (unlinkErr.code !== 'ENOENT') cleanupErrors.push(unlinkErr);
    }
    if (cleanupErrors.length > 0) err.cleanupErrors = cleanupErrors;
    throw err;
  }
}

/**
 * The compensations for the steps a command has completed, so a failure part
 * way leaves the files as the command found them. A step's undo is recorded
 * only once the step has succeeded.
 */
class UndoLog {
  constructor() {
    /** @type {Array<{ description: string, undo: () => void }>} */
    this.steps = [];
  }

  /**
   * Records how to undo a completed step.
   *
   * @param {string} description What the undo does, phrased after "cannot", for a failure report.
   * @param {() => void} undo The compensation; it throws when it cannot complete.
   */
  push(description, undo) {
    this.steps.push({ description, undo });
  }

  /**
   * Runs every recorded undo, newest first. Each failure is caught on its
   * own, so one failing undo never stops the others; this never throws.
   *
   * @returns {string[]} One message per undo that failed; empty when everything was undone.
   */
  rollback() {
    const failures = [];
    while (this.steps.length > 0) {
      const { description, undo } = this.steps.pop();
      try {
        undo();
      } catch (err) {
        failures.push(`cannot ${description} (${err?.message ?? String(err)})`);
      }
    }
    return failures;
  }
}

/**
 * Undo of a file the command created: removes `rel` only while it still holds
 * exactly `bytes` and `sourceRel`, the copy it was made from, still exists.
 * Rolling back therefore never deletes the last copy of an article, nor an
 * edit made since the file was written; either refusal throws, so it is
 * reported as a rollback failure. A file already gone counts as undone.
 */
function removeCreated(root, rel, bytes, sourceRel) {
  const absPath = inRoot(root, rel);
  let current;
  try {
    current = fs.readFileSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (!current.equals(bytes)) throw new Error(`${rel} was edited after it was written, so it is kept`);
  if (!pathExists(inRoot(root, sourceRel))) {
    throw new Error(`${sourceRel} is missing, so ${rel} is kept as the only copy`);
  }
  fs.unlinkSync(absPath);
}

/** Every folder below `absDir` (itself excluded), each parent before its children, as absolute paths. */
function listFolders(absDir) {
  const folders = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(absDir, entry.name);
    folders.push(child);
    for (const folder of listFolders(child)) folders.push(folder);
  }
  return folders;
}

/**
 * Where `publish` or `unpublish` sets the article it is moving aside at its
 * commit point: `_drafts/.<slug>.publishing` or `_drafts/.<slug>.unpublishing`.
 * The folder is git-ignored, and the leading dot keeps Jekyll and `check`
 * from reading the file.
 */
function asideRelFor(slug, command) {
  return `_drafts/.${slug}.${command}ing`;
}

/**
 * First half of the commit point of `publish` and `unpublish`: moves the
 * source article to `asideRel` with one atomic rename. From then on an editor
 * saving the article writes a new file at `sourceRel`, never into the copy
 * about to be deleted. A source already gone throws `SourceChanged`.
 */
function setAside(root, sourceRel, asideRel, command) {
  try {
    fs.renameSync(inRoot(root, sourceRel), inRoot(root, asideRel));
  } catch (err) {
    if (err.code === 'ENOENT') throw new SourceChanged(`${sourceRel} disappeared while ${command}ing`);
    throw err;
  }
}

/**
 * Second half of the commit point: throws `SourceChanged` unless the
 * set-aside copy holds exactly `snapshot`, the bytes the command read,
 * checked and copied, and nothing has been saved at `sourceRel` since it was
 * set aside. The undo of `setAside` then keeps the edit.
 */
function assertAsideUnchanged(root, asideRel, sourceRel, snapshot, command) {
  const kept = `your edit is kept; check it and ${command} again`;
  if (!fs.readFileSync(inRoot(root, asideRel)).equals(snapshot)) {
    throw new SourceChanged(`${sourceRel} changed while ${command}ing; ${kept}`);
  }
  if (pathExists(inRoot(root, sourceRel))) {
    throw new SourceChanged(`${sourceRel} was saved again while ${command}ing; ${kept}`);
  }
}

/**
 * First undo of `setAside`: copies the set-aside article back to `sourceRel`
 * without overwriting anything. When a newer save already occupies
 * `sourceRel` there is nothing to put back; `removeAside` then decides what
 * happens to the set-aside copy.
 */
function putBack(root, asideRel, sourceRel) {
  try {
    createExclusive(inRoot(root, sourceRel), fs.readFileSync(inRoot(root, asideRel)));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Second undo of `setAside`, run after `putBack`: deletes the set-aside copy
 * only while it is redundant, that is when `sourceRel` holds the same bytes
 * (it was put back) or when it is `snapshot`, the checked version a newer
 * save at `sourceRel` replaced. Otherwise it is the only copy of the source,
 * or an edit of its own, so it is kept and the undo throws naming it.
 */
function removeAside(root, asideRel, sourceRel, snapshot) {
  const asideAbs = inRoot(root, asideRel);
  let bytes;
  try {
    bytes = fs.readFileSync(asideAbs);
  } catch (err) {
    // Already gone: nothing to remove.
    if (err.code === 'ENOENT') return;
    throw err;
  }
  let source;
  try {
    source = fs.readFileSync(inRoot(root, sourceRel));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new Error(`${sourceRel} is missing, so ${asideRel} is kept as the only copy`);
  }
  if (!source.equals(bytes) && !bytes.equals(snapshot)) {
    throw new Error(`${sourceRel} was saved again meanwhile, so the earlier edit is kept in ${asideRel}`);
  }
  fs.unlinkSync(asideAbs);
}

/**
 * Refuses a run that finds the set-aside copy `asideRel` of an interrupted
 * run. A copy byte-identical to `sourceRel` is redundant, so it is removed
 * with a warning and the run goes on; any other copy may be the only one of
 * some edit, so the run is refused. Returns `false` once a refusal is reported.
 */
function clearLeftoverAside(root, asideRel, sourceRel, command) {
  const asideAbs = inRoot(root, asideRel);
  if (!pathExists(asideAbs)) return true;
  try {
    if (isFile(inRoot(root, sourceRel))
      && fs.readFileSync(asideAbs).equals(fs.readFileSync(inRoot(root, sourceRel)))) {
      fs.unlinkSync(asideAbs);
      warn(`removed ${asideRel}, an identical copy of ${sourceRel} left by an interrupted ${command}`);
      return true;
    }
  } catch (err) {
    fail(`cannot clear ${asideRel}, left by an interrupted ${command} (${err.message}); delete it by hand, `
      + `then ${command} again; nothing was moved`);
    return false;
  }
  fail(`${asideRel} is left from an interrupted ${command} and may hold a copy of the article; compare it `
    + `with ${sourceRel}, delete it, then ${command} again; nothing was moved`);
  return false;
}

/* ------------------------------------------------------------------------ */
/* Per-slug lock (new, publish, unpublish)                                   */
/* ------------------------------------------------------------------------ */

/** True unless process `pid` is known to be gone; one owned by another user counts as running. */
function processRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

/** Removes the folder `rel` if this run made it and it is empty again; a failure is only a warning. */
function removeMadeFolder(root, rel) {
  const absPath = inRoot(root, rel);
  try {
    if (fs.readdirSync(absPath).length === 0) fs.rmdirSync(absPath);
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`cannot remove the empty ${rel}/ made for the lock (${err.message})`);
  }
}

/** Releases a lock taken by `acquireSlugLock`; a failure is only a warning, as the next run replaces a stale lock. */
function releaseSlugLock(root, rel, owner, madeDrafts) {
  const absPath = inRoot(root, rel);
  try {
    if (fs.readFileSync(absPath).equals(owner)) fs.unlinkSync(absPath);
    else warn(`${rel} no longer holds this run's lock, so it is left in place`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      warn(`cannot remove the lock ${rel} (${err.message}); the next run replaces it, or delete it by hand`);
    }
  }
  if (madeDrafts) removeMadeFolder(root, '_drafts');
}

/**
 * Takes the lock `_drafts/.<slug>.lock` for one run of `new`, `publish` or
 * `unpublish`, so two runs for the same slug never interleave. Exclusive
 * creation of the dated post alone cannot serialize them: two runs on either
 * side of UTC midnight write different filenames. The lock file names its
 * holder as `<pid> <host>`. A lock whose holder ran on this host and is no
 * longer running is stale and is replaced with a warning, so a killed run
 * never blocks a retry; any other existing lock refuses the run and names
 * the file to delete once no run is active. Two runs replacing the same
 * stale lock at the same instant could both proceed; the window is the gap
 * between reading and removing the stale file.
 *
 * A `_drafts/` folder made for the lock is removed again on release when
 * empty, so a refused command still writes nothing.
 *
 * @returns {{ release: () => void } | null} The held lock, or `null` once the refusal is reported.
 */
function acquireSlugLock(root, slug, command) {
  const rel = `_drafts/.${slug}.lock`;
  const owner = Buffer.from(`${process.pid} ${os.hostname()}\n`, 'utf8');
  let madeDrafts;
  try {
    madeDrafts = fs.mkdirSync(inRoot(root, '_drafts'), { recursive: true }) !== undefined;
  } catch (err) {
    fail(`${command} failed: cannot create the _drafts/ folder for its lock (${err.message}); nothing was changed`);
    return null;
  }
  if (takeLockFile(root, rel, owner, slug, command)) {
    return { release: () => releaseSlugLock(root, rel, owner, madeDrafts) };
  }
  if (madeDrafts) removeMadeFolder(root, '_drafts');
  return null;
}

/**
 * Creates the lock file `rel` holding `owner`, replacing a stale one (see
 * `acquireSlugLock`). Returns `false` once the reason it cannot is reported.
 */
function takeLockFile(root, rel, owner, slug, command) {
  const absPath = inRoot(root, rel);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      createExclusive(absPath, owner);
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        fail(`${command} failed: cannot create the lock ${rel} (${err.message}); nothing was changed`);
        return false;
      }
    }
    let held;
    try {
      held = fs.readFileSync(absPath);
    } catch (err) {
      // Released between the attempt and this read: try again.
      if (err.code === 'ENOENT') continue;
      fail(`${command} failed: cannot read the lock ${rel} (${err.message}); nothing was changed`);
      return false;
    }
    const holder = /^(\d+) (\S+)\n$/.exec(held.toString('utf8'));
    if (holder !== null && holder[2] === os.hostname() && !processRunning(Number(holder[1]))) {
      try {
        if (fs.readFileSync(absPath).equals(held)) fs.unlinkSync(absPath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          fail(`${command} failed: cannot remove the stale lock ${rel} (${err.message}); delete it by hand`);
          return false;
        }
      }
      warn(`replaced the stale lock ${rel}: process ${holder[1]}, which held it, is no longer running`);
      continue;
    }
    const who = holder === null ? '' : ` (process ${holder[1]} on ${holder[2]})`;
    fail(`another article.mjs run${who} is changing slug ${slug}; wait for it to finish, then run ${command} `
      + `again. If no such run is active, delete ${rel} first; nothing was changed`);
    return false;
  }
  fail(`${command} failed: the lock ${rel} kept changing while it was being taken; run ${command} again`);
  return false;
}

/**
 * Runs `body` while holding the slug's lock and returns its exit code; the
 * lock is released however `body` ends. Returns 1 when the lock is held by
 * another run.
 */
function withSlugLock(root, slug, command, body) {
  const lock = acquireSlugLock(root, slug, command);
  if (lock === null) return EXIT_INVALID;
  try {
    return body();
  } finally {
    lock.release();
  }
}

/**
 * Reports a failed step of `new`, `publish` or `unpublish` and rolls back the
 * steps completed before it. Prints the failing step with its error, each
 * cleanup error attached to it and each rollback failure. Then it either says
 * that every change was rolled back (only when that is true), or lists which
 * of `paths` now exist and which are missing, for the author to fix by hand.
 *
 * @param {object} args
 * @param {'new' | 'publish' | 'unpublish'} args.command The command that failed.
 * @param {string} args.root Absolute repository root.
 * @param {string} args.step What the failing step does, phrased after "cannot".
 * @param {unknown} args.err What the step threw; a `SourceChanged` message is printed as it is.
 * @param {UndoLog} args.undo The completed steps' compensations.
 * @param {string[]} args.paths Repository-relative paths the command works on (folders end in `/`).
 * @param {string[]} [args.leftovers] Paths that exist only part way, such as the set-aside copy;
 *   listed only when present.
 * @param {string} args.untouched What a complete rollback leaves, such as `nothing was moved`.
 * @returns {number} Exit code 1.
 */
function reportFailure({ command, root, step, err, undo, paths, leftovers = [], untouched }) {
  if (err instanceof SourceChanged) fail(`${command} failed: ${err.message}`);
  else fail(`${command} failed: cannot ${step} (${err?.message ?? String(err)})`);
  const cleanupErrors = Array.isArray(err?.cleanupErrors) ? err.cleanupErrors : [];
  for (const cleanupErr of cleanupErrors) fail(`cleanup failed: ${cleanupErr?.message ?? String(cleanupErr)}`);
  const failures = undo.rollback();
  for (const message of failures) fail(`rollback failed: ${message}`);
  if (cleanupErrors.length === 0 && failures.length === 0) {
    fail(`every change was rolled back and ${untouched}; fix the cause and run ${command} again`);
    return EXIT_INVALID;
  }
  const present = [];
  const missing = [];
  const unknown = [];
  for (const rel of [...paths, ...leftovers]) {
    try {
      if (pathExists(inRoot(root, rel.replace(/\/$/, '')))) present.push(rel);
      else if (paths.includes(rel)) missing.push(rel);
    } catch (statErr) {
      unknown.push(`${rel} (${statErr?.code ?? statErr?.message ?? String(statErr)})`);
    }
  }
  fail('not every change could be rolled back; fix these paths by hand:');
  process.stderr.write(`  present: ${present.join(', ') || 'none'}\n`);
  process.stderr.write(`  missing: ${missing.join(', ') || 'none'}\n`);
  if (unknown.length > 0) process.stderr.write(`  cannot tell: ${unknown.join(', ')}\n`);
  return EXIT_INVALID;
}

/* ------------------------------------------------------------------------ */
/* new <slug>                                                                */
/* ------------------------------------------------------------------------ */

/**
 * True when `core.hooksPath` points at this clone's `.githooks/`. Git resolves
 * a relative value against the working-tree root, so `.githooks`,
 * `./.githooks` and the absolute path are all accepted. The check is
 * advisory: when git cannot answer (not installed, killed, out of time), the
 * cause is warned about and the hooks are reported as not enabled.
 */
function hooksEnabled(root) {
  let result;
  try {
    result = runGit(root, ['config', '--get', 'core.hooksPath']);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    warn(`cannot read core.hooksPath (${err.message})`);
    return false;
  }
  if (!result.ok) return false;
  const value = result.stdout.toString('utf8').trim();
  return value !== '' && path.resolve(root, value) === path.resolve(root, '.githooks');
}

function cmdNew(root, slug) {
  if (!isValidSlug(slug)) return refuseSlug(slug);
  return withSlugLock(root, slug, 'new', () => createDraft(root, slug));
}

/** `new <slug>` once the slug's lock is held. */
function createDraft(root, slug) {
  const draftRel = `_drafts/${slug}.md`;
  const used = [...findDrafts(root, slug), ...findPosts(root, slug)];
  if (pathExists(inRoot(root, draftRel)) && !used.includes(draftRel)) used.unshift(draftRel);
  if (used.length > 0) {
    fail(`slug ${slug} is already used by ${used.join(', ')}; choose another slug`);
    return EXIT_INVALID;
  }
  const draftImagesRel = `assets/drafts/${slug}`;
  const draftImagesAbs = inRoot(root, draftImagesRel);
  if (pathExists(draftImagesAbs) && !isRealDirectory(draftImagesAbs)) {
    fail(`${draftImagesRel} is not a folder (or is a symbolic link); move it aside and run new again; `
      + 'nothing was created');
    return EXIT_INVALID;
  }

  let template;
  try {
    template = fs.readFileSync(inRoot(root, '_templates/article.md'));
  } catch (err) {
    fail(`cannot read _templates/article.md under ${root} (${err.code ?? err.message})`);
    return EXIT_INVALID;
  }

  // The draft's undo is recorded once it exists, so a failure creating its
  // image folder (a file where assets/drafts/ should be, say) removes the
  // draft again and the slug stays free for a retry. A `_drafts/` folder this
  // run made is removed with the lock when it is empty again.
  const undo = new UndoLog();
  let step = 'create the _drafts/ folder';
  try {
    fs.mkdirSync(inRoot(root, '_drafts'), { recursive: true });
    // Exclusive creation never overwrites: a draft created since the check above is kept.
    step = `write ${draftRel}`;
    createExclusive(inRoot(root, draftRel), template);
    undo.push(`remove ${draftRel}`, () => removeCreated(root, draftRel, template, '_templates/article.md'));
    step = `create ${draftImagesRel}/`;
    fs.mkdirSync(draftImagesAbs, { recursive: true });
  } catch (err) {
    return reportFailure({
      command: 'new',
      root,
      step,
      err,
      undo,
      paths: [draftRel, `${draftImagesRel}/`],
      untouched: 'no draft was created',
    });
  }

  say(`Created ${draftRel} from _templates/article.md, and assets/drafts/${slug}/ for its images.`);
  say('Both folders are git-ignored: the draft stays on this machine until you publish it.');
  const outside = runsOutsideRoot(root);
  if (!hooksEnabled(root)) {
    warn(`git hooks are not enabled for this clone; run: git ${outside ? `-C ${shellQuote(root)} ` : ''}`
      + 'config core.hooksPath .githooks');
  }
  say();
  say('Next:');
  if (outside) say(`  cd ${shellQuote(root)}`);
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
 * Checks the post `publish` is about to write, before anything moves. The
 * draft check cannot vouch for it: the post rules add the filename date (an
 * `updated` date earlier than the publish date is refused, for one), and the
 * image paths may have been rewritten. Its images are looked up where they
 * still are: `/assets/blog/<slug>/<file>` exists when
 * `assets/drafts/<slug>/<file>` does. Slug uniqueness is left to the draft
 * check, which already reports every post and other draft with the slug,
 * whereas a post check would count the draft being published; the Liquid
 * warnings were printed by the draft check.
 *
 * @param {string} root Absolute repository root.
 * @param {string} postRel Repository-relative path the post will have.
 * @param {string} slug The article's slug.
 * @param {string} today The UTC date the post filename carries.
 * @param {string} postText The text the post will hold.
 * @returns {string[]} Errors, each starting with `postRel`.
 */
function checkProspectivePost(root, postRel, slug, today, postText) {
  const { data, body, errors: parseErrors } = parseArticle(postText);
  const errors = parseErrors.map((message) => `${postRel}: ${message}`);
  const bodyStartLine = postText.slice(0, postText.length - body.length).split('\n').length;
  const draftImageExists = makeImageExists(root);
  const blogPrefix = `/assets/blog/${slug}/`;
  const imageExists = (publicPath) => typeof publicPath === 'string' && publicPath.startsWith(blogPrefix)
    && draftImageExists(`/assets/drafts/${slug}/${publicPath.slice(blogPrefix.length)}`);
  const postErrors = validateArticle({
    path: postRel,
    data,
    body,
    kind: 'post',
    todayUtc: today,
    imageExists,
    bodyStartLine,
  });
  for (const message of postErrors) errors.push(message);
  for (const finding of scanUnsafeMarkup(body)) {
    errors.push(`${postRel}:${bodyStartLine + finding.line - 1}: unsafe markup "${finding.text}"`);
  }
  return errors;
}

function cmdPublish(root, slug) {
  if (!isValidSlug(slug)) return refuseSlug(slug);
  const draftRel = `_drafts/${slug}.md`;
  if (!isFile(inRoot(root, draftRel))) {
    fail(`${draftRel} does not exist; start a draft with: node scripts/article.mjs new ${slug}`);
    return EXIT_INVALID;
  }
  return withSlugLock(root, slug, 'publish', () => publishDraft(root, slug));
}

/** `publish <slug>` once the slug's lock is held; the date is read under the lock as well. */
function publishDraft(root, slug) {
  const today = todayUtc();
  const draftRel = `_drafts/${slug}.md`;
  const draftAbs = inRoot(root, draftRel);
  const asideRel = asideRelFor(slug, 'publish');
  if (!clearLeftoverAside(root, asideRel, draftRel, 'publish')) return EXIT_INVALID;

  // One read: the post is written from exactly the bytes checked here.
  let snapshot;
  try {
    snapshot = fs.readFileSync(draftAbs);
  } catch (err) {
    fail(`${draftRel}: cannot read the file (${err.code ?? err.message}); nothing was moved`);
    return EXIT_INVALID;
  }
  const { errors, warnings, text, data } = checkText(root, draftRel, 'draft', today, snapshot.toString('utf8'));
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

  // The image paths change only when the folder moves with the article;
  // otherwise the post is the checked bytes themselves.
  const postText = moveImages
    ? replaceAllText(text, `/assets/drafts/${slug}/`, `/assets/blog/${slug}/`)
    : text;
  const postBytes = moveImages ? Buffer.from(postText, 'utf8') : snapshot;
  const postErrors = checkProspectivePost(root, postRel, slug, today, postText);
  if (postErrors.length > 0) {
    for (const message of postErrors) fail(message);
    fail(`publish refused (${plural(postErrors.length, 'problem')}): the post would fail check; nothing was moved`);
    return EXIT_INVALID;
  }

  // Order: write the post, then move the images, then retire the draft. Each
  // step records its undo once it has succeeded, and any failure undoes the
  // steps before it, newest first, so a failed publish can simply be run
  // again. Retiring the draft is the commit point: it is the last step, and
  // the draft is untouched until then. Folders made on the way (`_posts/`,
  // `assets/blog/`) stay: an empty folder is invisible to git and to a retry.
  //
  // Concurrency: competing new, publish and unpublish runs for this slug wait
  // on its lock, held by the caller. An editor saving the draft meanwhile is
  // handled at the commit point: the draft is set aside with one rename, its
  // bytes must still be the checked snapshot, and nothing may have been saved
  // in its place; otherwise everything is undone and the edit is kept.
  const undo = new UndoLog();
  let step = 'create the _posts/ folder';
  try {
    fs.mkdirSync(inRoot(root, '_posts'), { recursive: true });
    step = `write ${postRel}`;
    createExclusive(postAbs, postBytes);
    undo.push(`remove ${postRel}`, () => removeCreated(root, postRel, postBytes, draftRel));
    if (moveImages) {
      step = 'create the assets/blog/ folder';
      fs.mkdirSync(inRoot(root, 'assets/blog'), { recursive: true });
      step = `move ${draftImagesRel}/ to ${blogImagesRel}/`;
      fs.renameSync(draftImagesAbs, blogImagesAbs);
      undo.push(`move ${blogImagesRel}/ back to ${draftImagesRel}/`,
        () => fs.renameSync(blogImagesAbs, draftImagesAbs));
    } else if (imageFolder) {
      // Only empty folders remain inside, so an article without images creates
      // no image folder. Recreating folders is harmless where they still
      // exist, so this undo is recorded first: it also repairs a removal that
      // stopped part way.
      step = `remove the empty ${draftImagesRel}/`;
      const folders = [draftImagesAbs, ...listFolders(draftImagesAbs)];
      undo.push(`recreate the empty ${draftImagesRel}/`, () => {
        for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
      });
      fs.rmSync(draftImagesAbs, { recursive: true });
    }
    step = `set ${draftRel} aside as ${asideRel}`;
    setAside(root, draftRel, asideRel, 'publish');
    undo.push(`remove the set-aside copy ${asideRel}`, () => removeAside(root, asideRel, draftRel, snapshot));
    undo.push(`put ${draftRel} back from ${asideRel}`, () => putBack(root, asideRel, draftRel));
    step = `check that ${draftRel} is unchanged`;
    assertAsideUnchanged(root, asideRel, draftRel, snapshot, 'publish');
    // The commit point; nothing can fail after it. The draft is no longer at
    // its path, so a save landing now creates a new draft rather than being
    // deleted with this copy; it is reported below.
    step = `remove ${draftRel}`;
    fs.unlinkSync(inRoot(root, asideRel));
  } catch (err) {
    return reportFailure({
      command: 'publish',
      root,
      step,
      err,
      undo,
      paths: [draftRel, postRel, `${draftImagesRel}/`, `${blogImagesRel}/`],
      leftovers: [asideRel],
      untouched: 'nothing was moved',
    });
  }

  if (pathExists(draftAbs)) {
    warn(`${draftRel} was saved again as publishing finished: ${postRel} holds the checked text, and your `
      + `newer save is kept in ${draftRel}. Both use slug ${slug}; copy the edit into the post, then delete the draft`);
  }
  say(`Published ${draftRel} as ${postRel}.`);
  if (moveImages) say(`Moved ${draftImagesRel}/ to ${blogImagesRel}/ and rewrote the image paths.`);
  else if (imageFolder) say(`Removed the empty ${draftImagesRel}/.`);
  const title = typeof data.title === 'string' ? data.title : slug;
  say();
  say('Next:');
  if (runsOutsideRoot(root)) say(`  cd ${shellQuote(root)}`);
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
  return withSlugLock(root, slug, 'unpublish', () => unpublishPost(root, slug));
}

/** `unpublish <slug>` once the slug's lock is held. */
function unpublishPost(root, slug) {
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
  const asideRel = asideRelFor(slug, 'unpublish');
  for (const [rel, abs] of [[draftRel, draftAbs], [`${draftImagesRel}/`, draftImagesAbs]]) {
    if (pathExists(abs)) {
      fail(`${rel} already exists; move it aside so unpublishing overwrites nothing`);
      return EXIT_INVALID;
    }
  }
  if (!clearLeftoverAside(root, asideRel, postRel, 'unpublish')) return EXIT_INVALID;
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
  // One read: the draft is written from exactly these bytes, and the post is
  // removed only while it still holds them.
  let snapshot;
  try {
    snapshot = fs.readFileSync(postAbs);
  } catch (err) {
    fail(`${postRel}: cannot read the file (${err.code ?? err.message}); nothing was moved`);
    return EXIT_INVALID;
  }
  const draftBytes = moveImages
    ? Buffer.from(replaceAllText(snapshot.toString('utf8'), `/assets/blog/${slug}/`, `/assets/drafts/${slug}/`))
    : snapshot;

  // Order: write the draft, then move the images, then retire the post, with
  // the same undo log, lock and commit point as publish; the post is set
  // aside in the git-ignored _drafts/ folder. A failure therefore never
  // leaves the live post with its images moved to the git-ignored
  // assets/drafts/.
  const undo = new UndoLog();
  let step = 'create the _drafts/ folder';
  try {
    fs.mkdirSync(inRoot(root, '_drafts'), { recursive: true });
    step = `write ${draftRel}`;
    createExclusive(draftAbs, draftBytes);
    undo.push(`remove ${draftRel}`, () => removeCreated(root, draftRel, draftBytes, postRel));
    if (moveImages) {
      step = 'create the assets/drafts/ folder';
      fs.mkdirSync(inRoot(root, 'assets/drafts'), { recursive: true });
      step = `move ${blogImagesRel}/ to ${draftImagesRel}/`;
      fs.renameSync(blogImagesAbs, draftImagesAbs);
      undo.push(`move ${draftImagesRel}/ back to ${blogImagesRel}/`,
        () => fs.renameSync(draftImagesAbs, blogImagesAbs));
    }
    step = `set ${postRel} aside as ${asideRel}`;
    setAside(root, postRel, asideRel, 'unpublish');
    undo.push(`remove the set-aside copy ${asideRel}`, () => removeAside(root, asideRel, postRel, snapshot));
    undo.push(`put ${postRel} back from ${asideRel}`, () => putBack(root, asideRel, postRel));
    step = `check that ${postRel} is unchanged`;
    assertAsideUnchanged(root, asideRel, postRel, snapshot, 'unpublish');
    // The commit point, as in publish: a save landing now recreates the post
    // rather than being deleted with this copy; it is reported below.
    step = `remove ${postRel}`;
    fs.unlinkSync(inRoot(root, asideRel));
  } catch (err) {
    return reportFailure({
      command: 'unpublish',
      root,
      step,
      err,
      undo,
      paths: [postRel, draftRel, `${blogImagesRel}/`, `${draftImagesRel}/`],
      leftovers: [asideRel],
      untouched: 'nothing was moved',
    });
  }

  if (pathExists(postAbs)) {
    warn(`${postRel} was saved again as unpublishing finished: ${draftRel} holds the unpublished text, and `
      + `your newer save is kept in ${postRel}. Both use slug ${slug}; copy the edit into the draft, then delete `
      + 'the post');
  }
  say(`Unpublished ${postRel}; it is now the draft ${draftRel}.`);
  if (moveImages) say(`Moved ${blogImagesRel}/ to ${draftImagesRel}/ and rewrote the image paths.`);
  say();
  say('Next:');
  if (runsOutsideRoot(root)) say(`  cd ${shellQuote(root)}`);
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

/**
 * Reads the given articles from tree or index entries, each with its blob id
 * as `id`; a submodule in an article path is an error.
 */
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
    articles.push({ path: p, text: readBlob(entry.oid), id: entry.oid });
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
  for (const message of checkTrackedContent({ paths, articles, todayUtc: today })) errors.push(message);

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
  // Text analyses by blob id for this run: path, date and image rules still run per commit.
  const analyses = new Map();

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
    const content = checkTrackedContent({ paths: [...tree.keys()], articles, todayUtc: today, cache: analyses });
    for (const message of content) errors.push(message);
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
