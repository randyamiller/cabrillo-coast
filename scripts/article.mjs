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
 *   node scripts/article.mjs guard --pre-push [<remote> <url>]
 *                                              pre-push: the same for every commit or tree being pushed
 *
 * `--root <dir>` (anywhere on the command line) names the repository root and
 * defaults to the current directory. `new`, `check`, `publish` and
 * `unpublish` refuse a root without `_config.yml` (exit 2), so a run from a
 * subfolder is never taken for a site without articles; `guard` finds the
 * repository root with git. `guard --pre-push` takes the remote name and URL
 * git gives the hook: it skips only commits the repository at that URL
 * advertises (`git ls-remote`) that it already holds, and otherwise checks
 * the complete history of what is pushed.
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
 * `./lib/articles.mjs`, and the site-configuration rules (settings in the
 * Jekyll configuration file that would keep a tracked post off the site) live
 * in `./lib/site-config.mjs`, so commit time, push time and test time apply
 * identical checks. This file only reads and moves files, runs git plumbing
 * and reports.
 *
 * What `guard` reads: the index (`--staged`) or the pushed commits
 * (`--pre-push`), never working-tree files, with one exception. It lists the
 * working tree's folders for symbolic links named `_drafts` or
 * `assets/drafts` and resolves where they lead (`makeDraftLinkCheck`), so a
 * file in a repository folder that such a link makes a drafts folder is
 * refused as a draft.
 *
 * Git safety: the tool never changes git state. Only `new` and `guard` run
 * git, and only read-only commands (`config --get`, `ls-files`, `diff`,
 * `rev-parse`, `hash-object` without `-w`, `cat-file` (`--batch-check`
 * included), `rev-list`, `ls-tree`, `diff-tree`, and `ls-remote` with
 * `GIT_TERMINAL_PROMPT=0`), spawned without a shell and with
 * `GIT_OPTIONAL_LOCKS=0` so not even an opportunistic index refresh is
 * written. Every git command runs
 * under a one-minute deadline (`DEADLINES.gitQuery` in `./lib/subprocess.mjs`)
 * and is killed with SIGKILL when it exceeds it; `guard` then refuses with
 * exit 1, and `new` warns.
 *
 * Changing files: `new`, `publish` and `unpublish` hold a per-slug lock,
 * `_drafts/.<slug>.lock`, while they change files; a competing run for the
 * same slug is refused and must be run again. `publish` and `unpublish` never
 * delete the article they retire: it stays in the git-ignored
 * `_drafts/.<slug>.<command>-backup` (numbered when taken) for the author to
 * delete. When a step fails, they try to undo the completed steps, newest
 * first, and each undo first checks that it removes no content the run did
 * not write. An undo that cannot complete is reported with the paths to
 * repair by hand; empty folders made on the way may remain.
 *
 * Output: every line goes through `emit`, the one place that writes to stdout
 * or stderr, which writes control characters as JSON escapes (`\u001b`,
 * `\r`, …), so each message is exactly one terminal line. File names and
 * article text come from the repository, which a checked-out pull request can
 * supply, and must not retitle the terminal, clear it or erase a refusal line
 * (CWE-150).
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
import { checkSiteConfig, siteConfigFile } from './lib/site-config.mjs';

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

/** Index and tree mode of a submodule (gitlink), which is refused at every path (`entryModeProblem`). */
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
  guard --pre-push [<remote> <url>]
                      Refuse a push whose commits or trees break the content
                      rules, or that pushes a blob; reads git's ref lines on
                      stdin (run by .githooks/pre-push). Only commits the
                      repository at <url> advertises holding are skipped;
                      without <url>, all history pushed is checked

Options:
  --root <dir>        Repository root, the folder holding _config.yml (default:
                      the current directory)
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

/** The article or image folder being moved was changed while `publish` or `unpublish` ran; its message says which. */
class SourceChanged extends Error {}

/**
 * Standard output and error streams on which a write has failed (see
 * `watchOutput`); `emit` writes nothing more to them.
 */
const closedStreams = new Set();

/**
 * The characters a terminal acts on instead of showing: every C0 control but
 * TAB (U+0000 to U+001F, LF and CR included), DEL (U+007F) and every C1
 * control (U+0080 to U+009F, among them the one-character CSI U+009B). TAB is
 * kept: it only advances the cursor to the next tab stop, and can neither move
 * it back, erase anything nor start an escape sequence.
 */
const TERMINAL_CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** The short forms `JSON.stringify` uses for the controls that have one (TAB aside, which is kept). */
const SHORT_CONTROL_ESCAPES = new Map([['\b', '\\b'], ['\n', '\\n'], ['\f', '\\f'], ['\r', '\\r']]);

/**
 * `text` with every `TERMINAL_CONTROL_RE` character written as the escape
 * `JSON.stringify` uses: `\n`, `\r`, `\b` and `\f`, and `\u00XX` in lowercase
 * hex for the rest (ESC is `\u001b`, BEL `\u0007`, the C1 CSI `\u009b`), so a
 * file name reads as it does in `refuseSlug`'s message. Backslashes are left
 * as they are: the printed next-step commands hold `shellQuote`'s `'\''`.
 */
function neutralizeControls(text) {
  return text.replace(TERMINAL_CONTROL_RE, (control) => SHORT_CONTROL_ESCAPES.get(control)
    ?? `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Writes `line` and a newline to `stream`, the only place this tool writes to
 * its output, unless a write to it has already failed (`closedStreams`).
 * Control characters are neutralized (`neutralizeControls`), so each call is
 * exactly one terminal line: file names and article text come from the
 * repository, and a crafted one can neither retitle or clear the terminal nor
 * erase or forge a line (CWE-150).
 *
 * @param {NodeJS.WriteStream} stream `process.stdout` or `process.stderr`.
 * @param {string} line One line of output, without its newline.
 */
function emit(stream, line) {
  if (!closedStreams.has(stream)) stream.write(`${neutralizeControls(line)}\n`);
}

/**
 * Handles a failed write to stdout or stderr, which Node reports as an
 * `error` event once the command has returned (its writes are synchronous)
 * and which, unhandled, would end the run with a stack trace and exit 1. A
 * reader that closes its end early (`| head -1`) makes writes fail with
 * EPIPE; that loses only output nobody reads, so the stream is muted and the
 * command's own exit code stands, 0 for a publish whose moves completed. Any
 * other failure, a full disk say, loses output the author needs: it is
 * reported on stderr while stderr still works, and the exit code becomes 1.
 */
function watchOutput() {
  for (const [stream, name] of [[process.stdout, 'standard output'], [process.stderr, 'standard error']]) {
    stream.on('error', (err) => {
      if (closedStreams.has(stream)) return;
      closedStreams.add(stream);
      if (err?.code === 'EPIPE') return;
      process.exitCode = EXIT_INVALID;
      fail(`cannot write to ${name} (${err?.message ?? String(err)}); output was lost`);
    });
  }
}

function say(message = '') {
  emit(process.stdout, message);
}

function fail(message) {
  emit(process.stderr, `error: ${message}`);
}

/** Advisory findings go to stderr, prefixed `warning: `; they never change the exit code. */
function warn(message) {
  emit(process.stderr, `warning: ${message}`);
}

/**
 * Reports text that can span lines: git's own stderr inside a `GitError`
 * message, or the stack of an unexpected error. The first line is an error
 * (`fail`) and every further line is indented by two spaces, so none can pose
 * as a top-level `error:`, `warning:`, `ok` or `guard:` line.
 */
function failLines(text) {
  const [first, ...rest] = String(text).split(/\r?\n/);
  fail(first);
  for (const line of rest) emit(process.stderr, `  ${line}`);
}

/** Writes `USAGE` to `stream` one line at a time; its final newline ends the last line, adding no blank one. */
function printUsage(stream) {
  for (const line of USAGE.replace(/\n$/, '').split('\n')) emit(stream, line);
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
 * A repository-relative path as one argument of a printed next-step command.
 * A path of only letters, digits, `.`, `_`, `/` and `-` that does not start
 * with `-` is printed as it is; any other is quoted with `shellQuote`, so a
 * nested `_posts/` folder whose name holds a space, a quote or `$(…)` is
 * neither split nor run when the command is pasted into a POSIX shell.
 */
function shellPath(relPath) {
  return /^(?!-)[A-Za-z0-9._/-]+$/.test(relPath) ? relPath : shellQuote(relPath);
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
 * cannot exist: missing, below a file (`ENOTDIR`), too long for the
 * filesystem (`ENAMETOOLONG`) or, when following links, a symbolic-link loop
 * (`ELOOP`). Other errors, such as `EACCES`, are thrown.
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
 * The first component of the repository-relative `relPath` through which a
 * read or write could leave the root or land in another folder, or `null`
 * when there is none. Every component below the root is read with `lstat`,
 * so no link is followed: a symbolic link is returned with reason `link`, and
 * so is the last component when it exists but is not what `leaf` asks for,
 * with reason `type`. The root itself may be a link (macOS `/var`); once
 * every component below it is a real folder, `relPath` resolves inside the
 * root's real path. A missing component ends the walk, as does one below a
 * component that is not a folder (`ENOTDIR`): nothing can exist there, and
 * creating anything there fails before it writes.
 *
 * @param {string} root Absolute repository root.
 * @param {string} relPath Repository-relative POSIX path; a trailing `/` is ignored.
 * @param {'folder' | 'file'} leaf What the last component must be when it exists.
 * @returns {{ rel: string, reason: 'link' | 'type', must: string } | null} `must` names what
 *   `rel` has to be, for a message.
 * @throws {Error} when a component cannot be read, such as `EACCES`.
 */
function firstUnconfined(root, relPath, leaf) {
  const segments = relPath.split('/').filter((segment) => segment !== '');
  for (let i = 0; i < segments.length; i += 1) {
    const rel = segments.slice(0, i + 1).join('/');
    const last = i === segments.length - 1;
    const must = last && leaf === 'file' ? 'a regular file' : 'a real folder';
    const stat = statOrUndefined(inRoot(root, rel), false);
    if (stat === undefined) return null;
    if (stat.isSymbolicLink()) return { rel, reason: 'link', must };
    if (last && !(leaf === 'file' ? stat.isFile() : stat.isDirectory())) return { rel, reason: 'type', must };
  }
  return null;
}

/** Why `relPath` is not confined (see `firstUnconfined`), as a message, or `null` when it is. */
function confinementProblem(root, relPath, leaf) {
  const found = firstUnconfined(root, relPath, leaf);
  if (found === null) return null;
  let what = 'a symbolic link';
  if (found.reason === 'type') what = found.must === 'a regular file' ? 'not a regular file' : 'not a folder';
  return `${found.rel} is ${what}; it must be ${found.must} inside the repository`;
}

/** Every symbolic link below the real folder `relDir`, searched recursively without following any, sorted. */
function linksBelow(root, relDir) {
  const links = [];
  const entries = fs.readdirSync(inRoot(root, relDir), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) links.push(child);
    else if (entry.isDirectory()) for (const link of linksBelow(root, child)) links.push(link);
  }
  return links;
}

/**
 * Every `*.md` regular file under `folder` (repository-relative), searched
 * recursively, as sorted repository-relative POSIX paths. A missing folder
 * yields `[]`. No symbolic link is followed or listed, `folder` itself
 * included; each one met is added to `links` when the caller passes an
 * array, so the caller can report it.
 *
 * @param {string} root Absolute repository root.
 * @param {string} folder Repository-relative folder, such as `_posts`.
 * @param {string[]} [links] Receives the repository-relative path of every symbolic link met.
 * @returns {string[]}
 */
function listMarkdown(root, folder, links) {
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
      if (entry.isSymbolicLink()) links?.push(child);
      else if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(child);
    }
  };
  if (statOrUndefined(inRoot(root, folder), false)?.isSymbolicLink()) links?.push(folder);
  else visit(folder);
  return found;
}

/**
 * Posts under `_posts/` (recursively) whose filename is `<date>-<slug>.md`.
 * Symbolic links with such a name are not posts; they are added to `links`
 * when the caller passes an array.
 */
function findPosts(root, slug, links) {
  const isPost = (rel) => {
    const m = POST_FILE_RE.exec(path.posix.basename(rel));
    return m !== null && m[2] === slug;
  };
  const met = [];
  const posts = listMarkdown(root, '_posts', met).filter(isPost);
  if (links) for (const link of met.filter(isPost)) links.push(link);
  return posts;
}

/** Drafts under `_drafts/` (recursively) named `<slug>.md`. */
function findDrafts(root, slug) {
  return listMarkdown(root, '_drafts').filter((rel) => path.posix.basename(rel) === `${slug}.md`);
}

/**
 * Refuses `new`, `publish` or `unpublish` of `slug` unless every path it
 * reads, creates or moves is confined (see `firstUnconfined`): `_drafts/`
 * with the slug's lock, draft and set-aside copy, `_posts/` and, for
 * `unpublish`, the slug's post with its folders, `assets/drafts/<slug>/`,
 * `assets/blog/<slug>/` and, for `new`, `_templates/article.md`. A folder
 * aliased by a symbolic link would otherwise put a draft, its lock or its
 * images in a folder git publishes, or outside the root; a linked source
 * file would be read from wherever it points. `publish` also refuses links
 * inside the draft image folder, as git would commit the link instead of the
 * image. Each command runs this before taking the lock and again under it,
 * before its first change. Returns `false` once the refusal is reported.
 *
 * @param {string} root Absolute repository root.
 * @param {'new' | 'publish' | 'unpublish'} command The command about to change files.
 * @param {string} slug A valid slug.
 * @returns {boolean}
 */
function pathsConfined(root, command, slug) {
  const draftImagesRel = `assets/drafts/${slug}`;
  // The lock path is the one acquireSlugLock creates.
  const checks = [
    [`_drafts/.${slug}.lock`, 'file'],
    [`_drafts/${slug}.md`, 'file'],
    ['_posts', 'folder'],
    [draftImagesRel, 'folder'],
  ];
  if (command === 'new') checks.push(['_templates/article.md', 'file']);
  else checks.push([asideRelFor(slug, command), 'file'], [`assets/blog/${slug}`, 'folder']);
  const problems = new Set();
  try {
    for (const [rel, leaf] of checks) {
      const problem = confinementProblem(root, rel, leaf);
      if (problem !== null) problems.add(problem);
    }
    if (command === 'unpublish' && problems.size === 0) {
      const links = [];
      for (const post of findPosts(root, slug, links)) {
        const problem = confinementProblem(root, post, 'file');
        if (problem !== null) problems.add(problem);
      }
      for (const link of links) {
        problems.add(`${link} is a symbolic link; it must be a regular file inside the repository`);
      }
    }
    if (command === 'publish' && problems.size === 0 && isRealDirectory(inRoot(root, draftImagesRel))) {
      for (const link of linksBelow(root, draftImagesRel)) {
        problems.add(`${link} is a symbolic link; images must be regular files in real folders, `
          + 'as git would commit the link instead of the image');
      }
    }
  } catch (err) {
    fail(`${command} failed: cannot check the paths it uses (${err.message}); nothing was changed`);
    return false;
  }
  if (problems.size === 0) return true;
  for (const problem of problems) fail(problem);
  fail(`${command} refused: it uses only real folders and regular files inside the repository, never a `
    + 'symbolic link, which could lead outside it or into a folder git publishes; fix the '
    + `${problems.size === 1 ? 'path' : 'paths'} above, then run ${command} again; nothing was changed`);
  return false;
}

/**
 * `imageExists` for `validateArticle`: maps a root-relative public path such
 * as `/assets/drafts/foo/fig.png` to the file `<root>/assets/drafts/foo/fig.png`.
 * A path with `.`, `..` or empty segments, or one that would resolve outside
 * the root, never exists; neither does a folder, nor a file reached through
 * a symbolic link: GitHub Pages does not follow links, and git would commit
 * the link instead of the image. Each such link is added to `links` when the
 * caller passes an array.
 *
 * @param {string} root Absolute repository root.
 * @param {string[]} [links] Receives the repository-relative path of each symbolic link that hides an image.
 * @returns {(publicPath: string) => boolean}
 */
function makeImageExists(root, links) {
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
      const found = firstUnconfined(root, segments.join('/'), 'file');
      if (found?.reason === 'link') links?.push(found.rel);
      return found === null && pathExists(target);
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
  const imageLinks = [];
  const articleErrors = validateArticle({
    path: relPath,
    data,
    body,
    kind,
    todayUtc: today,
    imageExists: makeImageExists(root, imageLinks),
    bodyStartLine,
  });
  for (const message of articleErrors) errors.push(message);
  // Says why an image that is on disk was reported missing.
  for (const link of new Set(imageLinks)) {
    errors.push(`${relPath}: ${link} is a symbolic link, so the images through it count as missing; images must `
      + 'be regular files in real folders inside the repository');
  }
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
 * Offset of the first byte of the first sequence in `bytes` that is not
 * valid UTF-8, or -1 when every byte is. Validity is the WHATWG Encoding
 * Standard's, which Ruby's, and so Jekyll's, matches: a stray continuation
 * byte, the bytes C0, C1 and F5 to FF, an overlong form, a surrogate
 * (U+D800 to U+DFFF), a code point above U+10FFFF and a sequence cut short
 * by another byte or by the end of the bytes are all invalid, each at the
 * offset of the byte that starts it.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function invalidUtf8Offset(bytes) {
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i];
    if (lead < 0x80) {
      i += 1;
      continue;
    }
    let needed;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      needed = 1;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      needed = 2;
      if (lead === 0xe0) lower = 0xa0; // below: an overlong form
      if (lead === 0xed) upper = 0x9f; // above: a surrogate
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      needed = 3;
      if (lead === 0xf0) lower = 0x90; // below: an overlong form
      if (lead === 0xf4) upper = 0x8f; // above: beyond U+10FFFF
    } else {
      return i;
    }
    for (let k = 1; k <= needed; k += 1) {
      const next = bytes[i + k];
      if (next === undefined || next < lower || next > upper) return i;
      lower = 0x80;
      upper = 0xbf;
    }
    i += needed + 1;
  }
  return -1;
}

/**
 * Decodes an article's bytes exactly as UTF-8 (`STRICT_UTF8`: a leading
 * byte-order mark is kept, as a lossy read keeps it), or locates the first
 * invalid sequence. The Pages build cannot read an article that is not
 * UTF-8: Jekyll logs "invalid byte sequence in UTF-8", leaves the article out
 * of the site and still succeeds, so check, publish and guard refuse it
 * instead of checking the replacement characters a lossy read would give.
 * The result depends on the bytes alone, so `guard` caches it by blob id.
 *
 * @param {Uint8Array} bytes The article's complete content.
 * @returns {{ text: string, invalid: null } | { text: null, invalid: string }} `invalid` locates
 *   the first invalid sequence by byte offset (from 0) and line (from 1), for `notUtf8`.
 * @throws {Error} what the decoder threw, when it failed for a reason other than invalid bytes.
 */
function decodeUtf8(bytes) {
  try {
    return { text: STRICT_UTF8.decode(bytes), invalid: null };
  } catch (err) {
    const offset = err?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? invalidUtf8Offset(bytes) : -1;
    if (offset === -1) throw err;
    let line = 1;
    for (let nl = bytes.indexOf(0x0a); nl !== -1 && nl < offset; nl = bytes.indexOf(0x0a, nl + 1)) line += 1;
    return { text: null, invalid: `byte offset ${offset}, line ${line}` };
  }
}

/** The error for an article that `decodeUtf8` found is not valid UTF-8. */
function notUtf8(relPath, invalid) {
  return `${relPath}: not valid UTF-8 (${invalid}); save the file as UTF-8`;
}

/**
 * Runs `checkText` on one file on disk; a file that cannot be read, or is
 * not valid UTF-8 (`decodeUtf8`), is reported as its only error.
 *
 * @param {string} root Absolute repository root.
 * @param {string} relPath Repository-relative POSIX path of the article.
 * @param {'draft' | 'post'} kind Which folder rules apply.
 * @param {string} [today] Today as `YYYY-MM-DD` in UTC, read once per command.
 * @returns {{ errors: string[], warnings: string[], text: string, data: Record<string, unknown> }}
 */
function checkFile(root, relPath, kind, today = todayUtc()) {
  let bytes;
  try {
    bytes = fs.readFileSync(inRoot(root, relPath));
  } catch (err) {
    const errors = [`${relPath}: cannot read the file (${err.code ?? err.message})`];
    return { errors, warnings: [], text: '', data: {} };
  }
  const { text, invalid } = decodeUtf8(bytes);
  if (invalid !== null) return { errors: [notUtf8(relPath, invalid)], warnings: [], text: '', data: {} };
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
 * @param {string} cwd Folder git runs in.
 * @param {string[]} args Git's arguments.
 * @param {Buffer} [input] Standard input.
 * @param {Record<string, string>} [env] Variables set for this command only.
 * @returns {{ ok: boolean, stdout: Buffer, stderr: string, detail: string }}
 *   The exit of a git that ran to its end; when `ok` is false, `detail` is
 *   git's trimmed stderr, or its exit status when stderr is empty.
 * @throws {GitError} naming the command and how it ended, when git did not run to its end.
 */
function runGit(cwd, args, input, env = {}) {
  const result = runSync('git', args, {
    cwd,
    input,
    encoding: 'buffer',
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' },
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

/**
 * Decodes UTF-8 exactly: an invalid byte is an error rather than U+FFFD, and
 * a leading byte-order mark stays part of the text rather than being dropped.
 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The C escapes git uses when it quotes a path, by byte. */
const GIT_QUOTE_ESCAPES = new Map([
  [0x07, 'a'], [0x08, 'b'], [0x09, 't'], [0x0a, 'n'], [0x0b, 'v'], [0x0c, 'f'], [0x0d, 'r'],
  [0x22, '"'], [0x5c, '\\'],
]);

/**
 * Bytes quoted as `git status` quotes a path (`core.quotePath`, the default):
 * printable ASCII as is, every other byte as a C or octal escape, so a name
 * that is not valid UTF-8 is shown exactly and matches git's own output.
 */
function gitQuote(bytes) {
  let quoted = '';
  for (const byte of bytes) {
    if (GIT_QUOTE_ESCAPES.has(byte)) quoted += `\\${GIT_QUOTE_ESCAPES.get(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `"${quoted}"`;
}

/**
 * Decodes bytes git printed as UTF-8, refusing any that are not valid UTF-8.
 * Git prints path bytes unchanged, and a lossy decoding gives byte-distinct
 * paths one name, so that one index or tree entry would hide another from
 * every check; such a name therefore makes `guard` refuse (fail closed).
 *
 * @param {Buffer} bytes Git's output.
 * @param {string} what What the bytes are, as the error names them.
 * @param {string} remedy What the author must do, as the error states it.
 * @throws {GitError} quoting the bytes as git does, when they are not valid UTF-8.
 */
function decodeGitText(bytes, what, remedy) {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new GitError(`${what} ${gitQuote(bytes)} is not valid UTF-8; ${remedy}`);
  }
}

/** Splits `-z` output into its NUL-terminated records, each decoded by `decodeGitText`. */
function splitNul(buffer) {
  const records = [];
  for (let start = 0; start < buffer.length;) {
    const nul = buffer.indexOf(0, start);
    const end = nul === -1 ? buffer.length : nul;
    if (end > start) {
      records.push(decodeGitText(buffer.subarray(start, end), 'the git record',
        'guard cannot tell such a path from others, so rename it to a valid UTF-8 name'));
    }
    start = end + 1;
  }
  return records;
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
  const top = decodeGitText(git(root, ['rev-parse', '--show-toplevel']), 'the repository folder',
    'move the repository to a folder whose path is valid UTF-8').replace(/\r?\n$/, '');
  if (top === '') throw new GitError(`git rev-parse --show-toplevel found no working tree for ${root}`);
  return top;
}

/**
 * Reads a blob's exact bytes by object id and decodes them with `decodeUtf8`,
 * caching the result by id so a blob shared by several commits is read and
 * decoded once. Reading by id with `cat-file blob` returns the stored content
 * with no textconv or filter applied, so the checks always see exactly what
 * would be published. Each article also carries this id to
 * `checkTrackedContent`, which caches the blob's parse and text analysis
 * under it (`guard --pre-push` shares one cache across all its commits), so
 * such a blob is also parsed once.
 *
 * @returns {(oid: string) => { text: string, invalid: null } | { text: null, invalid: string }}
 */
function makeBlobReader(cwd) {
  const cache = new Map();
  return (oid) => {
    if (!cache.has(oid)) cache.set(oid, decodeUtf8(git(cwd, ['cat-file', 'blob', oid])));
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
 * The compensations for the steps a command has completed, run newest first
 * when a later step fails. A step's undo is recorded only once the step has
 * succeeded. Each undo checks before it changes anything that it removes no
 * content the command did not write, and throws when it cannot complete;
 * `reportFailure` then lists the paths to repair by hand.
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
 * First step of the commit point of `publish` and `unpublish`: moves the
 * source article to `asideRel` with one atomic rename. From then on an editor
 * saving the article by its path writes a new file at `sourceRel`, never into
 * the copy being retired; a program that kept the file open still writes
 * into the copy, which `nameBackup` keeps under a backup name. A source
 * already gone throws `SourceChanged`.
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
 * Second step of the commit point: throws `SourceChanged` unless the
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
 * Error codes of a filesystem that cannot make hard links (FAT, exFAT and
 * some network shares), on which `nameBackup` renames instead.
 */
const NO_HARD_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * The names under which `publish` or `unpublish` keeps the article it
 * retired: `_drafts/.<slug>.<command>-backup`, then `-backup-2` to
 * `-backup-99`. The folder is git-ignored, and the leading dot and the
 * missing `.md` keep Jekyll and `check` from reading the file.
 */
function backupRelsFor(slug, command) {
  const base = `_drafts/.${slug}.${command}-backup`;
  return [base, ...Array.from({ length: 98 }, (_, i) => `${base}-${i + 2}`)];
}

/**
 * Third step of the commit point: gives the set-aside copy `asideRel` the
 * first free name of `candidates`, so the file the command retires is never
 * deleted. A program that kept the article open writes into that file
 * however late it writes, and the write stays readable under the backup
 * name; the author deletes the backup once it is no longer needed.
 *
 * The name is added with a hard link, which never replaces an existing file
 * (a taken name is skipped), and the caller then removes the name
 * `asideRel`. On a filesystem without hard links the copy is renamed to a
 * name found free instead; the slug's lock keeps other runs from taking it
 * meanwhile.
 *
 * @param {string} root Absolute repository root.
 * @param {string} asideRel The set-aside copy, already checked.
 * @param {string[]} candidates Backup names, in order of preference.
 * @returns {{ rel: string, linked: boolean }} The backup name, and whether
 *   `asideRel` still names the file too (a hard link was made).
 * @throws {Error} when every name is taken or the name cannot be added.
 */
function nameBackup(root, asideRel, candidates) {
  const asideAbs = inRoot(root, asideRel);
  for (const rel of candidates) {
    const backupAbs = inRoot(root, rel);
    try {
      fs.linkSync(asideAbs, backupAbs);
      return { rel, linked: true };
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (!NO_HARD_LINK_CODES.has(err.code)) throw err;
    }
    if (pathExists(backupAbs)) continue;
    fs.renameSync(asideAbs, backupAbs);
    return { rel, linked: false };
  }
  throw new Error(`every backup name from ${candidates[0]} to ${candidates.at(-1)} is taken; `
    + 'delete the backups you no longer need');
}

/**
 * Undo of `nameBackup` when it made a hard link: removes the name
 * `backupRel` only while `asideRel` still names the same file, so its
 * content keeps a name; otherwise the backup is kept and the undo throws
 * naming it. A backup already gone counts as undone.
 */
function removeBackupName(root, backupRel, asideRel) {
  const backup = statOrUndefined(inRoot(root, backupRel), false);
  if (backup === undefined) return;
  const aside = statOrUndefined(inRoot(root, asideRel), false);
  if (aside === undefined || aside.ino !== backup.ino || aside.dev !== backup.dev) {
    throw new Error(`${asideRel} no longer names the same file, so ${backupRel} is kept as the only copy`);
  }
  fs.unlinkSync(inRoot(root, backupRel));
}

/**
 * Says, once `publish` or `unpublish` has finished, where the retired
 * article is kept (see `nameBackup`). When the backup no longer holds
 * `snapshot`, a program that kept the article open wrote to it after the
 * check: `resultRel` holds the checked text and the later edit is in the
 * backup, which a warning names. The backup is never removed here.
 *
 * @param {string} root Absolute repository root.
 * @param {object} args
 * @param {string} args.backupRel The backup name.
 * @param {string} args.sourceRel Where the article was before it was retired.
 * @param {Buffer} args.snapshot The checked bytes.
 * @param {'publish' | 'unpublish'} args.command The command at its end.
 * @param {string} args.resultRel The file that now holds the checked text.
 */
function reportBackup(root, { backupRel, sourceRel, snapshot, command, resultRel }) {
  let bytes;
  try {
    bytes = fs.readFileSync(inRoot(root, backupRel));
  } catch (err) {
    warn(`cannot read the backup ${backupRel} (${err.message}); it is kept: compare it with ${resultRel}, `
      + 'then delete it');
    return;
  }
  if (bytes.equals(snapshot)) {
    say(`Kept the checked ${sourceRel} as ${backupRel} (git-ignored), in case a program still has it open; `
      + 'delete it once you no longer need it.');
    return;
  }
  warn(`${sourceRel} was written to through a file still open as ${command}ing finished: ${resultRel} holds the `
    + `checked text, and that later edit is in ${backupRel}; copy it into ${resultRel} if you want it, then `
    + `delete ${backupRel}`);
}

/**
 * First undo of `setAside`: gives the set-aside article its name `sourceRel`
 * again with a hard link, which never overwrites anything, so a program that
 * kept it open goes on writing into the restored file; on a filesystem
 * without hard links its bytes are copied there instead. When a newer save
 * already occupies `sourceRel` there is nothing to put back; `removeAside`
 * then decides what happens to the set-aside copy.
 */
function putBack(root, asideRel, sourceRel) {
  try {
    fs.linkSync(inRoot(root, asideRel), inRoot(root, sourceRel));
    return;
  } catch (err) {
    if (err.code === 'EEXIST') return;
    if (!NO_HARD_LINK_CODES.has(err.code)) throw err;
  }
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
 * `unpublish`. While one run holds it, a competing run for the same slug is
 * refused, not queued: it exits 1 naming the holder, changes nothing, and
 * must be run again once the holder has finished. Exclusive creation of the
 * dated post alone cannot serialize the runs: two on either side of UTC
 * midnight write different filenames. The lock file names its holder as
 * `<pid> <host>`.
 *
 * A lock whose holder ran on this host and is no longer running is stale, so
 * a killed run does not block a retry: `reclaimStaleLock` replaces it, with a
 * warning, under an exclusive reclaim token. Any other existing lock (a
 * running holder, another host, unreadable content) refuses the run and
 * names the file to delete once no run is active. A run removes only its own
 * lock and token, and a stale lock only while it holds the token; deleting a
 * lock or token by hand while its run is still active defeats the lock.
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
    const holder = parseHolder(held);
    if (holderGone(holder)) {
      const outcome = reclaimStaleLock(root, rel, owner, held, command);
      if (outcome === 'taken') return true;
      if (outcome === 'refused') return false;
      continue;
    }
    const who = holder === null ? '' : ` (process ${holder.pid} on ${holder.host})`;
    fail(`another article.mjs run${who} is changing slug ${slug}; wait for it to finish, then run ${command} `
      + `again. If no such run is active, delete ${rel} first; nothing was changed`);
    return false;
  }
  fail(`${command} failed: the lock ${rel} kept changing while it was being taken; run ${command} again`);
  return false;
}

/** The `<pid> <host>` record of a lock or reclaim token, or `null` for any other content. */
function parseHolder(bytes) {
  const match = /^(\d+) (\S+)\n$/.exec(bytes.toString('utf8'));
  return match === null ? null : { pid: match[1], host: match[2] };
}

/** True when `holder` (from `parseHolder`) ran on this host and is no longer running. */
function holderGone(holder) {
  return holder !== null && holder.host === os.hostname() && !processRunning(Number(holder.pid));
}

/**
 * Replaces the stale lock `rel`, which held `stale` when it was read, with
 * one holding `owner`. Only the run that creates the reclaim token
 * `<rel>.reclaim` exclusively may do so, so two runs that read the same stale
 * lock never both act on that reading: under the token the lock is read
 * again, removed only while it still holds `stale` and its holder is still
 * gone, and this run's lock is created exclusively before the token is
 * removed. A run that finds the token taken is refused (`refuseHeldToken`).
 *
 * @returns {'taken' | 'refused' | 'changed'} `taken` once this run holds the
 *   lock; `refused` once the reason it cannot is reported; `changed` when the
 *   lock is no longer the stale one read, or the token was released while
 *   being read, so the caller looks at the lock again.
 */
function reclaimStaleLock(root, rel, owner, stale, command) {
  const absPath = inRoot(root, rel);
  const tokenRel = `${rel}.reclaim`;
  try {
    createExclusive(inRoot(root, tokenRel), owner);
  } catch (err) {
    if (err.code === 'EEXIST') return refuseHeldToken(root, tokenRel, rel, command);
    fail(`${command} failed: cannot create ${tokenRel} to replace the stale lock ${rel} (${err.message}); `
      + 'nothing was changed');
    return 'refused';
  }
  let removed = false;
  try {
    let current;
    try {
      current = fs.readFileSync(absPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (current !== undefined) {
      if (!current.equals(stale) || !holderGone(parseHolder(current))) return 'changed';
      try {
        fs.unlinkSync(absPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    removed = true;
    try {
      createExclusive(absPath, owner);
    } catch (err) {
      // A run that found no lock at all took it first.
      if (err.code === 'EEXIST') return 'changed';
      throw err;
    }
    if (current !== undefined) {
      warn(`replaced the stale lock ${rel}: process ${parseHolder(stale).pid}, which held it, is no longer running`);
    }
    return 'taken';
  } catch (err) {
    fail(`${command} failed: cannot replace the stale lock ${rel} (${err.message}); `
      + `${removed ? '' : `delete ${rel} by hand, then `}run ${command} again; nothing was changed`);
    return 'refused';
  } finally {
    releaseReclaimToken(root, tokenRel, owner);
  }
}

/**
 * Reports that the reclaim token `tokenRel` of the lock `rel` is taken,
 * naming its holder. A token whose holder is gone is never removed here, as
 * removing it would race with the run creating the next one, so the author is
 * told to delete it. Returns `changed` when the token is already gone, since
 * its holder has just finished, and `refused` once the refusal is reported.
 */
function refuseHeldToken(root, tokenRel, rel, command) {
  let bytes;
  try {
    bytes = fs.readFileSync(inRoot(root, tokenRel));
  } catch (err) {
    if (err.code === 'ENOENT') return 'changed';
    fail(`${command} failed: cannot read ${tokenRel} (${err.message}); nothing was changed`);
    return 'refused';
  }
  const holder = parseHolder(bytes);
  if (holderGone(holder)) {
    fail(`${tokenRel} was left by process ${holder.pid}, which stopped while replacing the stale lock ${rel}; `
      + `delete ${tokenRel}, then run ${command} again; nothing was changed`);
  } else {
    const who = holder === null ? '' : ` (process ${holder.pid} on ${holder.host})`;
    fail(`another article.mjs run${who} is replacing the stale lock ${rel}; run ${command} again once it has `
      + `finished. If no such run is active, delete ${tokenRel} first; nothing was changed`);
  }
  return 'refused';
}

/** Removes this run's reclaim token, leaving one that holds another run's record; a failure is only a warning. */
function releaseReclaimToken(root, tokenRel, owner) {
  const absPath = inRoot(root, tokenRel);
  try {
    if (fs.readFileSync(absPath).equals(owner)) fs.unlinkSync(absPath);
    else warn(`${tokenRel} no longer holds this run's record, so it is left in place`);
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`cannot remove ${tokenRel} (${err.message}); delete it by hand`);
  }
}

/**
 * Runs `body` while holding the slug's lock and returns its exit code; the
 * lock is released however `body` ends. Returns 1 without running `body`
 * when the lock cannot be taken, such as while another run holds it; the
 * command must then be run again.
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
 * Nothing is rolled back when one of `paths` or `leftovers` is no longer
 * confined (see `firstUnconfined`), such as a folder replaced by a symbolic
 * link while the command ran: undoing through the link could remove or move
 * files outside the repository or into a folder git publishes, so every
 * completed step is left in place and reported for repair by hand.
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
  const unconfined = new Set();
  for (const rel of [...paths, ...leftovers]) {
    try {
      const problem = confinementProblem(root, rel, rel.endsWith('/') ? 'folder' : 'file');
      if (problem !== null) unconfined.add(problem);
    } catch (statErr) {
      unconfined.add(`cannot check ${rel} (${statErr?.code ?? statErr?.message ?? String(statErr)})`);
    }
  }
  for (const problem of unconfined) fail(`rollback skipped: ${problem}`);
  const failures = unconfined.size === 0 ? undo.rollback() : [];
  for (const message of failures) fail(`rollback failed: ${message}`);
  if (cleanupErrors.length === 0 && failures.length === 0 && unconfined.size === 0) {
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
  emit(process.stderr, `  present: ${present.join(', ') || 'none'}`);
  emit(process.stderr, `  missing: ${missing.join(', ') || 'none'}`);
  if (unknown.length > 0) emit(process.stderr, `  cannot tell: ${unknown.join(', ')}`);
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
  if (!pathsConfined(root, 'new', slug)) return EXIT_INVALID;
  return withSlugLock(root, slug, 'new', () => createDraft(root, slug));
}

/** `new <slug>` once the slug's lock is held. */
function createDraft(root, slug) {
  if (!pathsConfined(root, 'new', slug)) return EXIT_INVALID;
  const draftRel = `_drafts/${slug}.md`;
  const used = [...findDrafts(root, slug), ...findPosts(root, slug)];
  if (pathExists(inRoot(root, draftRel)) && !used.includes(draftRel)) used.unshift(draftRel);
  if (used.length > 0) {
    fail(`slug ${slug} is already used by ${used.join(', ')}; choose another slug`);
    return EXIT_INVALID;
  }
  const draftImagesRel = `assets/drafts/${slug}`;
  const draftImagesAbs = inRoot(root, draftImagesRel);

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
  say(`  3. node scripts/article.mjs check ${shellPath(draftRel)}`);
  say(`  4. node scripts/article.mjs publish ${slug}`);
  return EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* check [files…]                                                            */
/* ------------------------------------------------------------------------ */

/** What an entry that is not a regular file is, as a message names it: `a directory`, `a FIFO`, … */
function entryTypeName(stat) {
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFIFO()) return 'a FIFO';
  if (stat.isCharacterDevice()) return 'a character device';
  if (stat.isBlockDevice()) return 'a block device';
  if (stat.isSocket()) return 'a socket';
  return 'an entry of another type';
}

/**
 * The files `check` was given, resolved against the working directory. Each
 * must be a regular file, symbolic links followed; any other is a usage error
 * that says what it is: missing, a symbolic link that leads to no file (one
 * that dangles or loops), or a directory, FIFO, device or socket. A path is
 * only stat'ed, never opened, so a FIFO cannot stall the run.
 *
 * @throws {UsageError} for a named path that is not a regular file.
 */
function resolveCheckTargets(root, files) {
  const targets = [];
  const seen = new Set();
  for (const file of files) {
    const absFile = path.resolve(process.cwd(), file);
    const stat = statOrUndefined(absFile, true);
    if (stat === undefined) {
      throw new UsageError(statOrUndefined(absFile, false) === undefined
        ? `${file}: no such file`
        : `${file}: not a regular file (a symbolic link that leads to no file)`);
    }
    if (!stat.isFile()) throw new UsageError(`${file}: not a regular file (${entryTypeName(stat)})`);
    const rel = toPosix(path.relative(root, absFile));
    if (seen.has(rel)) continue;
    seen.add(rel);
    targets.push({ rel, kind: kindOf(root, absFile) });
  }
  return targets;
}

function cmdCheck(root, files) {
  const links = [];
  const targets = files.length > 0
    ? resolveCheckTargets(root, files)
    : [
      ...listMarkdown(root, '_drafts', links).map((rel) => ({ rel, kind: 'draft' })),
      ...listMarkdown(root, '_posts', links).map((rel) => ({ rel, kind: 'post' })),
    ];
  // Named files are checked for slug uniqueness against both folders, which are never listed through a link.
  if (files.length > 0) {
    for (const folder of ['_drafts', '_posts']) {
      if (statOrUndefined(inRoot(root, folder), false)?.isSymbolicLink()) links.push(folder);
    }
  }
  for (const rel of links) {
    fail(`${rel} is a symbolic link, which check does not follow; articles and their folders must be regular `
      + 'files and real folders inside the repository');
  }
  if (targets.length === 0) {
    if (links.length > 0) return EXIT_INVALID;
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
  return withErrors > 0 || links.length > 0 ? EXIT_INVALID : EXIT_OK;
}

/* ------------------------------------------------------------------------ */
/* publish <slug>                                                            */
/* ------------------------------------------------------------------------ */

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
  if (!pathsConfined(root, 'publish', slug)) return EXIT_INVALID;
  const draftRel = `_drafts/${slug}.md`;
  if (!isFile(inRoot(root, draftRel))) {
    // A repeat publish finds the post rather than a draft; `new` would refuse its slug.
    const posts = findPosts(root, slug);
    if (posts.length > 0) {
      fail(`slug ${slug} is already published as ${posts.join(', ')} and ${draftRel} does not exist; to update `
        + 'the article, edit the post, set updated: YYYY-MM-DD, then check, verify, commit and push; to take it '
        + `down, run: node scripts/article.mjs unpublish ${slug}`);
      return EXIT_INVALID;
    }
    fail(`${draftRel} does not exist; start a draft with: node scripts/article.mjs new ${slug}`);
    return EXIT_INVALID;
  }
  return withSlugLock(root, slug, 'publish', () => publishDraft(root, slug));
}

/** `publish <slug>` once the slug's lock is held; the date is read under the lock as well. */
function publishDraft(root, slug) {
  if (!pathsConfined(root, 'publish', slug)) return EXIT_INVALID;
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
  const decoded = decodeUtf8(snapshot);
  const { errors, warnings, text, data } = decoded.invalid === null
    ? checkText(root, draftRel, 'draft', today, decoded.text)
    : { errors: [notUtf8(draftRel, decoded.invalid)], warnings: [], text: '', data: {} };
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
  // step records its undo once it has succeeded, and a failure runs the undos
  // of the steps before it, newest first; each keeps content it did not
  // write, and one that cannot complete is reported with the paths to repair
  // by hand. Retiring the draft is the commit point: it is the last step, and
  // the draft is untouched until then. The retired draft is never deleted: it
  // is kept as a git-ignored backup in `_drafts/` (see `nameBackup`) for the
  // author to delete. Folders made on the way (`_posts/`, `assets/blog/`)
  // stay: an empty folder is invisible to git and to a retry.
  //
  // Concurrency: the caller holds this slug's lock, so a competing new,
  // publish or unpublish run for it is refused meanwhile and must be run
  // again once this one has finished. An editor saving the draft meanwhile is
  // handled at the commit point: the draft is set aside with one rename, its
  // bytes must still be the checked snapshot, and nothing may have been saved
  // in its place; otherwise the earlier steps are undone as above and the
  // edit is kept. A program that keeps the draft open and writes after that
  // check writes into the backup, which is reported once the run ends.
  const undo = new UndoLog();
  let step = 'create the _posts/ folder';
  let backup;
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
      // no image folder. Each folder is removed on its own, deepest first, and
      // `rmdirSync` refuses one that is not empty, so an image saved into it
      // since the check is never deleted: the run fails and is undone instead.
      // Recreating folders is harmless where they still exist, so this undo is
      // recorded first: it also repairs a removal that stopped part way.
      step = `remove the empty ${draftImagesRel}/`;
      const folders = [draftImagesAbs, ...listFolders(draftImagesAbs)];
      undo.push(`recreate the empty ${draftImagesRel}/`, () => {
        for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
      });
      for (const folder of [...folders].reverse()) {
        try {
          fs.rmdirSync(folder);
        } catch (err) {
          if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
          throw new SourceChanged(`${toPosix(path.relative(root, folder))}/ gained a file while publishing; it is `
            + 'kept; reference it from the draft or move it out, then publish again');
        }
      }
    }
    step = `set ${draftRel} aside as ${asideRel}`;
    setAside(root, draftRel, asideRel, 'publish');
    undo.push(`remove the set-aside copy ${asideRel}`, () => removeAside(root, asideRel, draftRel, snapshot));
    undo.push(`put ${draftRel} back from ${asideRel}`, () => putBack(root, asideRel, draftRel));
    step = `check that ${draftRel} is unchanged`;
    assertAsideUnchanged(root, asideRel, draftRel, snapshot, 'publish');
    step = `keep the checked ${draftRel} as a backup`;
    backup = nameBackup(root, asideRel, backupRelsFor(slug, 'publish'));
    if (backup.linked) {
      undo.push(`remove the backup name ${backup.rel}`, () => removeBackupName(root, backup.rel, asideRel));
      // The last transactional file mutation: nothing is rolled back once it
      // has succeeded. The draft is no longer at its path, so a save landing
      // now creates a new draft rather than being deleted, and the retired
      // file keeps its backup name, so a write through a file still open
      // stays readable there; both are reported below.
      step = `remove ${draftRel}`;
      fs.unlinkSync(inRoot(root, asideRel));
    }
  } catch (err) {
    return reportFailure({
      command: 'publish',
      root,
      step,
      err,
      undo,
      paths: [draftRel, postRel, `${draftImagesRel}/`, `${blogImagesRel}/`],
      leftovers: backup === undefined ? [asideRel] : [asideRel, backup.rel],
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
  reportBackup(root, { backupRel: backup.rel, sourceRel: draftRel, snapshot, command: 'publish', resultRel: postRel });
  const title = typeof data.title === 'string' ? data.title : slug;
  say();
  say('Next:');
  if (runsOutsideRoot(root)) say(`  cd ${shellQuote(root)}`);
  say('  node scripts/verify.mjs');
  say(`  git add -- ${shellPath(postRel)}${moveImages ? ` ${shellPath(blogImagesRel)}` : ''}`);
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
  if (!pathsConfined(root, 'unpublish', slug)) return EXIT_INVALID;
  return withSlugLock(root, slug, 'unpublish', () => unpublishPost(root, slug));
}

/** `unpublish <slug>` once the slug's lock is held. */
function unpublishPost(root, slug) {
  if (!pathsConfined(root, 'unpublish', slug)) return EXIT_INVALID;
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
    for (const ref of references) emit(process.stderr, `  ${ref.file}:${ref.line}: ${ref.text}`);
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
  // aside in the git-ignored _drafts/ folder and kept there as a backup the
  // author deletes. A failure before the post is
  // retired runs the undos, which move the images back to assets/blog/ and
  // remove the draft, so the live post is not left with its images in the
  // git-ignored assets/drafts/; an undo that cannot complete is reported with
  // the paths to repair by hand.
  const undo = new UndoLog();
  let step = 'create the _drafts/ folder';
  let backup;
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
    step = `keep the checked ${postRel} as a backup`;
    backup = nameBackup(root, asideRel, backupRelsFor(slug, 'unpublish'));
    if (backup.linked) {
      undo.push(`remove the backup name ${backup.rel}`, () => removeBackupName(root, backup.rel, asideRel));
      // The last transactional file mutation, as in publish: a save landing
      // now recreates the post rather than being deleted, and a write through
      // a file still open stays readable in the backup, which lies in the
      // git-ignored _drafts/, never under _posts/; both are reported below.
      step = `remove ${postRel}`;
      fs.unlinkSync(inRoot(root, asideRel));
    }
  } catch (err) {
    return reportFailure({
      command: 'unpublish',
      root,
      step,
      err,
      undo,
      paths: [postRel, draftRel, `${blogImagesRel}/`, `${draftImagesRel}/`],
      leftovers: backup === undefined ? [asideRel] : [asideRel, backup.rel],
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
  reportBackup(root, {
    backupRel: backup.rel,
    sourceRel: postRel,
    snapshot,
    command: 'unpublish',
    resultRel: draftRel,
  });
  say();
  say('Next:');
  if (runsOutsideRoot(root)) say(`  cd ${shellQuote(root)}`);
  // Stages the deletion of every path git tracks here and, unlike `git add`, ignores a path it never tracked.
  say(`  git rm -r -q --cached --ignore-unmatch -- ${shellPath(postRel)}`
    + `${moveImages ? ` ${shellPath(blogImagesRel)}` : ''}`);
  say(`  git commit -m "Unpublish: ${slug}"`);
  say('  git push origin main');
  say('If the post was never committed, there is nothing to commit: skip the commit and the push.');
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

/** Index and tree modes of a regular file, the only kind of entry that can be an article. */
const REGULAR_FILE_MODES = new Set(['100644', EXECUTABLE_MODE]);

/** Index and tree mode of a symbolic link. */
const SYMLINK_MODE = '120000';

/**
 * The refusal for an article path (`ARTICLE_PATH_RE`) whose index or tree
 * entry is not a regular file, or null for every other entry. Only a regular
 * file holds article text, so both guards apply this to every entry of the
 * complete tree, changed or not.
 */
function articleModeProblem(p, mode) {
  if (!ARTICLE_PATH_RE.test(p) || REGULAR_FILE_MODES.has(mode)) return null;
  if (mode === SYMLINK_MODE) return `${p}: a symbolic link cannot be an article`;
  if (mode === GITLINK_MODE) return `${p}: a submodule cannot be an article`;
  return `${p}: an article must be a regular file, not an entry of mode ${mode}`;
}

/**
 * The refusal for an index or tree entry by its mode, or null: an article
 * path that is not a regular file (`articleModeProblem`), or a submodule
 * anywhere. GitHub Pages builds a submodule's files into the site, where no
 * check reads them, so one at `_posts`, `blog/_posts` or any other folder
 * could publish unchecked posts, drafts or images; the site needs none.
 */
function entryModeProblem(p, mode) {
  const articleProblem = articleModeProblem(p, mode);
  if (articleProblem !== null) return articleProblem;
  if (mode === GITLINK_MODE) {
    return `${p}: submodules are not allowed; GitHub Pages builds a submodule's files into the site, where they `
      + 'would skip every check';
  }
  return null;
}

/**
 * Paths the commit adds, copies, modifies, renames or changes the type of (a
 * symbolic link or submodule that becomes a regular file, or the reverse). On
 * an unborn branch `git diff --cached` already compares against the empty
 * tree; should a git version refuse it there, the comparison is rerun against
 * the empty tree, computed by `hash-object` without `-w`, so nothing is written.
 */
function stagedChanges(top) {
  const args = ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z'];
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
 * as `id`. An entry that is not a regular file has no article text and is
 * never read; `entryModeProblem`, applied to the complete tree, refuses it.
 * An article that is not valid UTF-8, which the Pages build would leave out,
 * is not checked further: its refusal is added to `errors` instead.
 */
function readArticles(changedPaths, entryFor, readBlob, errors) {
  const articles = [];
  for (const p of changedPaths) {
    if (!ARTICLE_PATH_RE.test(p)) continue;
    const entry = entryFor(p);
    if (entry === undefined) throw new GitError(`${p} is listed as changed but has no entry in the tree`);
    if (!REGULAR_FILE_MODES.has(entry.mode)) continue;
    const { text, invalid } = readBlob(entry.oid);
    if (invalid === null) articles.push({ path: p, text, id: entry.oid });
    else errors.push(notUtf8(p, invalid));
  }
  return articles;
}

/** A link name that makes its target a drafts folder: `_drafts` in any folder, in any letter case. */
const DRAFTS_LINK_NAME_RE = /^_drafts$/iu;
/** A top-level `assets` folder, in any letter case, whose `drafts` entry is the draft-image folder. */
const ASSETS_FOLDER_NAME_RE = /^assets$/iu;
/** A link name inside `assets` that makes its target the draft-image folder, in any letter case. */
const DRAFT_IMAGES_LINK_NAME_RE = /^drafts$/iu;

/** Codes for a path that leads nowhere: missing (a dangling link), through a file, looping or over-long. */
const NOWHERE_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

/** `text` as a literal inside a regular expression with the `u` flag. */
function regExpLiteral(text) {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * Makes the check for drafts kept behind a symbolic link. `.gitignore`
 * ignores an entry named `_drafts`, or `assets/drafts`, in any letter case and
 * whatever its type, so when such an entry is a link to another folder of the
 * repository, `git add -A` stages that folder's files as ordinary files while
 * the local preview (`--drafts`) reads them as drafts. Each checked path at
 * or below such a target is refused; a link to the top folder itself is
 * refused once, by its own name.
 *
 * Links are found by their own type (`lstat`; none is followed while
 * searching) in the top folder and every folder that holds a checked path
 * (Jekyll reads `<dir>/_drafts/` in each folder it builds), and as `drafts`
 * in each top-level `assets` folder; names match in any letter case, as a
 * case-insensitive file system matches them.
 * Each link is resolved with `realpath`. A dangling link, one to anything but
 * a folder, and one that leads outside the repository (an author's own drafts
 * folder elsewhere, say) are left alone: no checked path lies in their
 * target. Paths are compared with the target in any letter case, so a
 * misjudgement can only produce a false finding. A folder no longer on disk
 * (or that cannot be one, as in `NOWHERE_CODES`) is skipped; any other error
 * reading the disk, such as `EACCES`, is thrown, so guard refuses.
 * Listings and targets are cached, so `guard --pre-push` reads each folder
 * once for all its commits. Nothing is written.
 *
 * @param {string} top The repository's top folder, as `gitToplevel` returns it.
 * @returns {(paths: string[]) => string[]} The refusals for one complete tree's paths.
 */
function makeDraftLinkCheck(top) {
  const realTop = fs.realpathSync.native(top);
  const insideTop = realTop.endsWith(path.sep) ? realTop : `${realTop}${path.sep}`;
  const listings = new Map();
  const targets = new Map();

  /** The entries of the repository folder `relDir`, sorted by name; none when it is gone from disk. */
  const entriesOf = (relDir) => {
    if (!listings.has(relDir)) {
      let entries = [];
      try {
        entries = fs.readdirSync(inRoot(top, relDir), { withFileTypes: true });
      } catch (err) {
        if (!NOWHERE_CODES.has(err.code)) throw err;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      listings.set(relDir, entries);
    }
    return listings.get(relDir);
  };

  /** The repository-relative folder the link `linkRel` leads to, `''` for the top folder, or null. */
  const targetOf = (linkRel) => {
    if (!targets.has(linkRel)) {
      let target = null;
      try {
        const real = fs.realpathSync.native(inRoot(top, linkRel));
        if (fs.statSync(real).isDirectory()) {
          if (real === realTop) target = '';
          else if (real.startsWith(insideTop)) target = toPosix(path.relative(realTop, real));
        }
      } catch (err) {
        if (!NOWHERE_CODES.has(err.code)) throw err;
      }
      targets.set(linkRel, target);
    }
    return targets.get(linkRel);
  };

  return (paths) => {
    const folders = new Set(['']);
    for (const p of paths) {
      for (let slash = p.indexOf('/'); slash !== -1; slash = p.indexOf('/', slash + 1)) folders.add(p.slice(0, slash));
    }
    const links = [];
    const collect = (relDir, nameRe, kind) => {
      for (const entry of entriesOf(relDir)) {
        if (entry.isSymbolicLink() && nameRe.test(entry.name)) {
          links.push({ rel: relDir === '' ? entry.name : `${relDir}/${entry.name}`, kind });
        }
      }
    };
    for (const relDir of folders) collect(relDir, DRAFTS_LINK_NAME_RE, 'drafts');
    for (const entry of entriesOf('')) {
      if (entry.isDirectory() && ASSETS_FOLDER_NAME_RE.test(entry.name)) {
        collect(entry.name, DRAFT_IMAGES_LINK_NAME_RE, 'draft images');
      }
    }

    // One link per target, so two links to one folder refuse each path once.
    const errors = [];
    const reported = new Set();
    for (const { rel, kind } of links) {
      const target = targetOf(rel);
      if (target === null || reported.has(target.toLowerCase())) continue;
      reported.add(target.toLowerCase());
      if (target === '') {
        errors.push(`${rel}: a symbolic link to the repository's top folder makes every file in it one of your `
          + `${kind}, which must never be tracked; replace ${rel} with a real, git-ignored folder`);
        continue;
      }
      const atOrBelow = new RegExp(`^${regExpLiteral(target)}(?:/|$)`, 'iu');
      for (const p of paths) {
        if (!atOrBelow.test(p)) continue;
        errors.push(`${p}: drafts and draft images must never be tracked; ${rel} is a symbolic link to ${target}/, `
          + `so the files there are ${kind} (git rm --cached, or replace ${rel} with a real, git-ignored folder)`);
      }
    }
    return errors;
  };
}

/**
 * The refusals for the Jekyll configuration of a complete tree or index:
 * `checkSiteConfig` on the file Jekyll reads (`siteConfigFile`), read from
 * its entry by blob id. Only a regular file can be read and checked, so a
 * symbolic link, a submodule or a folder in its place is refused, and so is
 * a file that is not valid UTF-8. A tree without a configuration file has
 * nothing to refuse.
 *
 * @param {string[]} paths The complete tree.
 * @param {(p: string) => { mode: string, oid: string } | undefined} entryFor The entry of a path.
 * @param {ReturnType<typeof makeBlobReader>} readBlob Reads and decodes a blob by id.
 * @returns {string[]}
 */
function siteConfigProblems(paths, entryFor, readBlob) {
  const file = siteConfigFile(paths);
  if (file === null) return [];
  const entry = entryFor(file);
  let kind = null;
  if (entry === undefined) kind = 'a folder';
  else if (entry.mode === SYMLINK_MODE) kind = 'a symbolic link';
  else if (entry.mode === GITLINK_MODE) kind = 'a submodule';
  else if (!REGULAR_FILE_MODES.has(entry.mode)) kind = `an entry of mode ${entry.mode}`;
  if (kind !== null) {
    return [`${file}: Jekyll reads the site configuration from this path, and guard can check it only as a regular `
      + `file, not ${kind}; track the configuration itself here`];
  }
  const { text, invalid } = readBlob(entry.oid);
  if (invalid !== null) return [notUtf8(file, invalid)];
  return checkSiteConfig({ path: file, text, paths });
}

function cmdGuardStaged(root) {
  const top = gitToplevel(root);
  const today = todayUtc();
  const records = parseIndex(git(top, ['ls-files', '-s', '-z']));
  const errors = [];

  // The complete staged tree, with the stage-0 entry of each path for reading.
  // The mode rules apply to every record, conflict stages included, and
  // report a path once.
  const paths = [];
  const entries = new Map();
  const modeReported = new Set();
  for (const record of records) {
    if (!entries.has(record.path)) paths.push(record.path);
    if (!entries.has(record.path) || record.stage === '0') entries.set(record.path, record);
    if (modeReported.has(record.path)) continue;
    if (record.path.startsWith('.githooks/') && record.mode !== EXECUTABLE_MODE) {
      modeReported.add(record.path);
      errors.push(`${record.path}: staged with mode ${record.mode}; run git update-index --chmod=+x -- `
        + shellPath(record.path));
    }
    const modeProblem = entryModeProblem(record.path, record.mode);
    if (modeProblem !== null) {
      modeReported.add(record.path);
      errors.push(modeProblem);
    }
  }

  for (const message of makeDraftLinkCheck(top)(paths)) errors.push(message);

  const readBlob = makeBlobReader(top);
  const articles = readArticles(stagedChanges(top), (p) => entries.get(p), readBlob, errors);
  // The regular files of the tree, so a symbolic link or submodule image counts as missing, as in check.
  const files = paths.filter((p) => REGULAR_FILE_MODES.has(entries.get(p).mode));
  for (const message of checkTrackedContent({ paths, files, articles, todayUtc: today })) errors.push(message);
  for (const message of siteConfigProblems(paths, (p) => entries.get(p), readBlob)) errors.push(message);

  if (errors.length > 0) {
    for (const message of errors) fail(message);
    emit(process.stderr, `guard: commit refused (${plural(errors.length, 'problem')}). `
      + 'Fix them, or unstage the files.');
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

/** A `git cat-file --batch-check='%(objectname) %(objecttype)'` answer for an object that exists. */
const BATCH_CHECK_RE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+)$/;

/**
 * The object each pushed ref line publishes, tags peeled: a pushed tag
 * publishes its target, which may be a commit, a tree or a blob, and
 * `rev-list` lists no commit at all for a tree or a blob. One
 * `git cat-file --batch-check` resolves `<local sha>^{}` for every line
 * that is not a deletion, which publishes nothing.
 *
 * @param {string} top Working-tree root.
 * @param {Array<{ localRef: string, localSha: string, remoteSha: string }>} lines From `parsePushLines`.
 * @returns {Array<{ localRef: string, remoteSha: string, oid: string, type: string }>} One entry
 *   per pushed line, in input order: the peeled object and its type.
 * @throws {GitError} when this clone lacks a pushed object, or git does not answer each line
 *   with one `<object> <type>` record.
 */
function peelPushed(top, lines) {
  const pushed = lines.filter(({ localSha }) => !ZERO_ID_RE.test(localSha));
  if (pushed.length === 0) return [];
  const format = '--batch-check=%(objectname) %(objecttype)';
  const input = Buffer.from(pushed.map(({ localSha }) => `${localSha}^{}\n`).join(''));
  const records = splitLines(git(top, ['cat-file', format], input));
  if (records.length !== pushed.length) {
    throw new GitError(`git cat-file ${format} answered ${records.length} of ${pushed.length} pushed objects`);
  }
  return pushed.map(({ localRef, localSha, remoteSha }, i) => {
    const match = BATCH_CHECK_RE.exec(records[i]);
    if (match !== null) return { localRef, remoteSha, oid: match[1], type: match[2] };
    if (records[i] === `${localSha}^{} missing`) {
      throw new GitError(`${localRef} ${localSha} is not an object in this clone, so it cannot be checked`);
    }
    throw new GitError(`unexpected git cat-file ${format} record for ${localRef}: ${records[i]}`);
  });
}

/**
 * Commits the push destination provably holds already: the commits its refs
 * point at, tags peeled, as the destination itself advertises them to
 * `git ls-remote -- <url>`, where `url` is where git is pushing (the hook's
 * `$2`). Git's push negotiation trusts the same advertisement: it never
 * sends the destination a commit it advertises. Remote-tracking refs prove
 * nothing, neither another remote's (a private one included) nor the
 * destination remote's own: a fetch from elsewhere or a `git remote set-url`
 * leaves them describing some other repository. Only advertised commits
 * this clone has can bound `rev-list`; the others are left out.
 *
 * With no destination, or when `ls-remote` exits non-zero (the destination
 * is unreachable, or needs credentials that no helper supplies, since it may
 * not prompt), nothing is proven and the whole pushed history is checked.
 * The same holds when `ls-remote --get-url` shows that a `url.<base>.insteadOf`
 * rule would send the query to another repository than the one git pushes to
 * (git has already rewritten `url` once). An `ls-remote` that does not answer
 * in time fails closed, as every git command here does.
 *
 * @param {string} top Working-tree root.
 * @param {{ url: string } | null} destination The URL git passes the pre-push hook, or null.
 * @returns {string[]} Commit ids the pushed history may stop at; `[]` when nothing is proven.
 * @throws {GitError} when git does not answer, or answers in a form not expected.
 */
function heldByDestination(top, destination) {
  if (destination === null || destination.url === '') return [];
  const env = { GIT_TERMINAL_PROMPT: '0' };
  const queried = runGit(top, ['ls-remote', '--get-url', '--', destination.url], undefined, env);
  if (!queried.ok || queried.stdout.toString('utf8') !== `${destination.url}\n`) return [];
  const listed = runGit(top, ['ls-remote', '--', destination.url], undefined, env);
  if (!listed.ok) return [];
  const advertised = new Set();
  for (const record of splitLines(listed.stdout)) {
    const oid = record.split('\t')[0];
    if (!OBJECT_ID_RE.test(oid)) throw new GitError(`unexpected git ls-remote record: ${record}`);
    advertised.add(oid.toLowerCase());
  }
  if (advertised.size === 0) return [];

  // One lookup for every advertised object: `<id>^{commit}` names the commit
  // it peels to, and is `missing` for one this clone lacks or that is no commit.
  const ids = [...advertised];
  const format = '--batch-check=%(objectname) %(objecttype)';
  const input = Buffer.from(ids.map((oid) => `${oid}^{commit}\n`).join(''));
  const answers = splitLines(git(top, ['cat-file', format], input));
  if (answers.length !== ids.length) {
    throw new GitError(`git cat-file ${format} answered ${answers.length} of ${ids.length} advertised objects`);
  }
  const held = new Set();
  answers.forEach((answer, i) => {
    const match = BATCH_CHECK_RE.exec(answer);
    if (match !== null && match[2] === 'commit') held.add(match[1]);
    else if (answer !== `${ids[i]}^{commit} missing`) {
      throw new GitError(`unexpected git cat-file ${format} record for ${ids[i]}: ${answer}`);
    }
  });
  return [...held];
}

/**
 * Every commit the push would publish, deduplicated across ref lines, for
 * the pushed commits (tags already peeled). When this clone has the remote
 * tip, the range is `<remote sha>..<commit>`. Otherwise (a new branch or
 * tag, or a remote tip this clone lacks) it is the commit's whole history
 * less the commits `heldByDestination` proves the destination holds. Those
 * tips reach `rev-list` as `^<id>` lines on standard input, so their number
 * is unbounded.
 *
 * @param {string} top Working-tree root.
 * @param {Array<{ oid: string, remoteSha: string }>} pushed Pushed commits from `peelPushed`.
 * @param {{ remote: string, url: string } | null} destination The hook's `<remote> <url>`, or null.
 * @returns {string[]} Commit ids, each once.
 */
function commitsToPush(top, pushed, destination) {
  const commits = [];
  const seen = new Set();
  let held = null;
  for (const { oid: tip, remoteSha } of pushed) {
    const known = !ZERO_ID_RE.test(remoteSha) && runGit(top, ['cat-file', '-e', `${remoteSha}^{commit}`]).ok;
    let listed;
    if (known) {
      listed = git(top, ['rev-list', `${remoteSha}..${tip}`]);
    } else {
      held ??= heldByDestination(top, destination);
      listed = git(top, ['rev-list', tip, '--stdin'], Buffer.from(held.map((oid) => `^${oid}\n`).join('')));
    }
    for (const commit of splitLines(listed)) {
      if (seen.has(commit)) continue;
      seen.add(commit);
      commits.push(commit);
    }
  }
  return commits;
}

/**
 * Parses `git ls-tree -r -z --full-tree`: `<mode> <type> <object>\t<path>`
 * records, keyed by path. A path listed twice is refused, since keying it
 * would let one entry hide the other from the checks.
 */
function parseTree(buffer) {
  const entries = new Map();
  for (const record of splitNul(buffer)) {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (tab <= 0 || !OBJECT_ID_RE.test(oid ?? '')) throw new GitError(`unexpected git ls-tree record: ${record}`);
    const p = record.slice(tab + 1);
    if (entries.has(p)) {
      throw new GitError(`git ls-tree listed ${JSON.stringify(p)} twice; a tree with duplicate entries `
        + 'cannot be checked');
    }
    entries.set(p, { mode, type, oid });
  }
  return entries;
}

/**
 * Problems in one snapshot a push publishes, a commit's tree or a pushed
 * tree: the mode rule, the draft-folder link rule, the tracked-content rules
 * and the site-configuration rules over its complete tree, and the article
 * rules over the articles at `changedPaths`. The tracked-content rules learn
 * which entries are regular files, so a symbolic link or submodule image
 * counts as missing, as `check` counts it.
 *
 * @param {Map<string, { mode: string, type: string, oid: string }>} entries The tree, from `parseTree`.
 * @param {string[]} changedPaths Paths whose articles are read and checked.
 * @param {{ readBlob: Function, today: string, analyses: Map<string, unknown>,
 *   draftLinkProblems: (paths: string[]) => string[] }} context Shared by every snapshot of the
 *   run, so a blob is read and analysed once and the working tree's draft-folder links once.
 * @returns {string[]} Problem messages; `[]` when the snapshot may be published.
 */
function snapshotProblems(entries, changedPaths, { readBlob, today, analyses, draftLinkProblems }) {
  const errors = [];
  for (const [p, { mode }] of entries) {
    const modeProblem = entryModeProblem(p, mode);
    if (modeProblem !== null) errors.push(modeProblem);
  }
  const paths = [...entries.keys()];
  for (const message of draftLinkProblems(paths)) errors.push(message);
  const articles = readArticles(changedPaths, (p) => entries.get(p), readBlob, errors);
  const files = paths.filter((p) => REGULAR_FILE_MODES.has(entries.get(p).mode));
  const content = checkTrackedContent({ paths, files, articles, todayUtc: today, cache: analyses });
  for (const message of content) errors.push(message);
  for (const message of siteConfigProblems(paths, (p) => entries.get(p), readBlob)) errors.push(message);
  return errors;
}

/**
 * Counts for a summary line: the non-zero ones, joined with commas and a
 * final `and` (`1 commit and 1 tree`), or the first noun with 0 when every
 * count is zero (`0 commits`).
 *
 * @param {Array<[number, string]>} counts `[count, noun]` pairs in the order to print.
 */
function objectCounts(counts) {
  const named = counts.filter(([count]) => count > 0).map(([count, noun]) => plural(count, noun));
  if (named.length === 0) return plural(0, counts[0][1]);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

/**
 * `guard --pre-push`: refuses the push (exit 1) when anything it would
 * publish breaks the content rules. Every pushed ref is peeled first. A
 * commit is checked with its whole pushed history (`commitsToPush`), each
 * commit's complete tree and the articles that commit adds or modifies. A
 * pushed tree is checked as a commit's tree, with every article in it read.
 * A blob has no path for any rule to judge, so pushing one is refused.
 *
 * @param {string} root The `--root` folder; git finds the working-tree root from it.
 * @param {string[]} args `[]`, or the `<remote> <url>` git passes the pre-push hook.
 * @returns {number} Exit code.
 */
function cmdGuardPrePush(root, args) {
  const lines = parsePushLines(readStdin());
  if (lines.length === 0) return EXIT_OK;
  const top = gitToplevel(root);
  const destination = args.length === 2 ? { remote: args[0], url: args[1] } : null;
  const pushed = peelPushed(top, lines);
  const commits = commitsToPush(top, pushed.filter(({ type }) => type === 'commit'), destination);
  const trees = [...new Set(pushed.filter(({ type }) => type === 'tree').map(({ oid }) => oid))];
  // Text analyses by blob id for this run: path, date and image rules still run per snapshot.
  // The working tree's draft-folder links are read once and applied to every pushed snapshot.
  const context = {
    readBlob: makeBlobReader(top), today: todayUtc(), analyses: new Map(),
    draftLinkProblems: makeDraftLinkCheck(top),
  };

  const problems = [];
  // Refused objects by type, in the order the summary names them.
  const refused = new Map([['commit', new Set()], ['tree', new Set()], ['blob', new Set()]]);
  const report = (oid, type, errors) => {
    if (errors.length === 0) return;
    if (!refused.has(type)) refused.set(type, new Set());
    refused.get(type).add(oid);
    for (const message of errors) problems.push(`${oid.slice(0, 7)}: ${message}`);
  };
  for (const commit of commits) {
    // The complete tree of every pushed commit, not only the tip: a draft
    // added and later deleted, or an image folder whose post was deleted, is
    // published by the commit that holds it.
    const entries = parseTree(git(top, ['ls-tree', '-r', '-z', '--full-tree', commit]));
    // --root lists a root commit's files; --diff-merges=first-parent lists a merge's changes.
    const changed = splitNul(git(top, [
      'diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '--diff-filter=AMT',
      '--diff-merges=first-parent', '-z', commit,
    ]));
    report(commit, 'commit', snapshotProblems(entries, changed, context));
  }
  for (const tree of trees) {
    // A tree has no parent to compare with: every article in it is new to the remote.
    const entries = parseTree(git(top, ['ls-tree', '-r', '-z', '--full-tree', tree]));
    report(tree, 'tree', snapshotProblems(entries, [...entries.keys()], context));
  }
  for (const { localRef, oid, type } of pushed) {
    if (type === 'commit' || type === 'tree') continue;
    report(oid, type, [`${localRef} points at a ${type}, which has no path, so guard cannot check it against `
      + 'the content rules; push a branch or tag that points at a commit instead']);
  }

  if (problems.length > 0) {
    for (const message of problems) fail(message);
    const objects = objectCounts([...refused].map(([type, ids]) => [ids.size, type]));
    emit(process.stderr, `guard: push refused (${plural(problems.length, 'problem')} in ${objects}).`);
    return EXIT_INVALID;
  }
  say(`guard: ok (${objectCounts([[commits.length, 'commit'], [trees.length, 'tree']])} checked)`);
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
    if (modes.length !== 1) throw new UsageError('guard needs exactly one of --staged or --pre-push');
    if (modes[0] === '--staged' && args.length > 0) {
      throw new UsageError(`unexpected arguments for guard --staged: ${args.join(' ')}`);
    }
    // The pre-push hook passes git's <remote> <url> pair; a run by hand may leave both out.
    if (modes[0] === '--pre-push' && args.length !== 0 && args.length !== 2) {
      throw new UsageError(`guard --pre-push takes either no arguments or <remote> <url>, not ${plural(args.length, 'argument')}`
        + `: ${args.join(' ')}`);
    }
  }

  const root = path.resolve(rootArg ?? process.cwd());
  // A name too long for the filesystem, or a link loop, cannot be a folder either: also a usage error.
  const rootStat = statOrUndefined(root, true);
  if (rootStat === undefined || !rootStat.isDirectory()) throw new UsageError(`--root ${root} is not a directory`);
  if (command !== 'guard') assertSiteRoot(root, rootArg !== null);
  return { help, root, command, args, modes };
}

/**
 * Refuses a root that is not the site root, the folder holding Jekyll's
 * `_config.yml`. From a subfolder such as `blog/`, `check` would otherwise
 * find no articles and exit 0, and `new`, `publish` and `unpublish` would
 * fail with messages that never name the root. No git is run: these
 * commands also work outside a repository. `guard` is not checked here, as
 * it finds the repository root with git itself.
 *
 * @param {string} root Absolute root the command would use.
 * @param {boolean} given True when `--root` named it, false when it is the current directory.
 * @throws {UsageError} naming the root and the nearest folder above it that holds `_config.yml`, if any.
 */
function assertSiteRoot(root, given) {
  if (isFile(path.join(root, '_config.yml'))) return;
  let above = null;
  for (let dir = root; above === null && path.dirname(dir) !== dir;) {
    dir = path.dirname(dir);
    try {
      if (isFile(path.join(dir, '_config.yml'))) above = dir;
    } catch {
      // A folder that cannot be read only goes unnamed in the hint; the refusal stands.
    }
  }
  const hint = above === null ? '' : ` (${above} holds _config.yml)`;
  throw new UsageError(given
    ? `--root ${root} is not the site root (it has no _config.yml); pass the repository root${hint}`
    : `${root} is not the site root (it has no _config.yml); run the command from the repository root${hint} `
      + 'or pass --root <dir>');
}

function run(argv) {
  const { help, root, command, args, modes } = parseArgs(argv);
  if (help) {
    printUsage(process.stdout);
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
      return modes[0] === '--staged' ? cmdGuardStaged(root) : cmdGuardPrePush(root, args);
  }
}

/**
 * Entry point. Usage errors print the usage block and exit 2; every other
 * failure, git errors included, exits 1, so a guard that cannot complete its
 * checks refuses rather than allows. The exit code is set rather than forced
 * so buffered output to a pipe is flushed first. A closed output pipe leaves
 * it as it is (`watchOutput`). A git error, which can carry git's own
 * multi-line stderr, and an unexpected error's stack are reported with
 * `failLines`: their further lines are indented.
 */
function main() {
  watchOutput();
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      fail(err.message);
      emit(process.stderr, '');
      printUsage(process.stderr);
      process.exitCode = EXIT_USAGE;
    } else if (err instanceof GitError) {
      failLines(err.message);
      fail('guard could not complete its checks, so it refuses (fail closed)');
      process.exitCode = EXIT_INVALID;
    } else if (typeof err?.code === 'string') {
      // A system error (it carries a code such as EACCES) is reported by its message.
      fail(err.message);
      process.exitCode = EXIT_INVALID;
    } else {
      // Anything else is unexpected, so its stack is kept.
      failLines(err?.stack ?? String(err));
      process.exitCode = EXIT_INVALID;
    }
  }
}

main();
