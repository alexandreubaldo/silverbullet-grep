import { datastore, editor, shell, system } from "$sb/syscalls.ts";
import { FileMeta } from "$sb/types.ts";

const VERSION = "2.3.0";

const resultPageSaved = "GREP RESULT";
const resultPageVirtual = "GREP RESULT 🔍";

// Add type definition for our config
interface GrepConfig {
  smartCase?: boolean;
  surround?: {
    left?: string;
    right?: string;
  } | false;
  saveResults?: boolean;
  ignoreFolders?: string[]; // New configuration option
}

export async function showVersion() {
  try {
    const { stdout } = await shell.run("git", ["--version"]);
    // Version info is in the first line
    const gitVersion = stdout.split("\n")[0];
    await editor.flashNotification(`Grep Plug ${VERSION} ${gitVersion}`);
  } catch {
    await editor.flashNotification(
      "Could not run 'git' command, make sure Git is in PATH",
      "error",
    );
  }
}

async function shouldIgnoreFolder(folderPath: string, config: GrepConfig): Promise<boolean> {
  if (!config.ignoreFolders) return false;
  
  // Normalize the folder path for comparison
  const normalizedPath = normalizePath(folderPath);
  
  return config.ignoreFolders.some(ignorePattern => {
    // Convert the ignore pattern to a proper path format
    const pattern = normalizePath(ignorePattern);
    
    // Check if the folder matches the ignore pattern
    // This handles both exact matches and wildcard patterns
    if (pattern.endsWith('/*')) {
      const basePattern = pattern.slice(0, -2);
      return normalizedPath.startsWith(basePattern);
    }
    return normalizedPath === pattern;
  });
}

async function grep(
  pattern: string,
  literal: boolean = false,
  folder: string = ".",
): Promise<string | undefined> {
  console.log(`grep("${pattern}", ${literal}, "${folder}")`);

  const config = await system.getSpaceConfig("grep", {}) as GrepConfig;

  let smartCase = true;
  if (config && config.smartCase === false) smartCase = false;

  let surroundLeft = ">>>";
  let surroundRight = "<<<";
  if (config && config.surround !== undefined) {
    if (config.surround === false) {
      surroundLeft = "";
      surroundRight = "";
    } else {
      if (config.surround.left) {
        surroundLeft = config.surround.left;
      }
      if (config.surround.right) {
        surroundRight = config.surround.right;
      }
    }
  }

  const caseSensitive = smartCase ? pattern.toLowerCase() !== pattern : true;

  let output: string;
  try {
    // Build git grep command with ignore patterns
    const gitArgs = [
      "-c", // modify config to this command
      "core.quotePath=false", // handle non-ASCII paths
      "grep",
      "--heading", // group by file
      "--break", // separate files with empty line
      "--line-number",
      "--column",
      "--no-color", // can't use terminal color here anyway
      "--no-index", // search like normal grep, no git-specific features
      ...(caseSensitive ? [] : ["--ignore-case"]),
      literal ? "--fixed-strings" : "--extended-regexp",
      pattern,
      "--",
      folder + (folder.endsWith("/") ? "" : "/") + "*.md",
    ];

    const result = await shell.run("git", gitArgs);
    if (result) {
      output = result.stdout;
    } else {
      editor.flashNotification(
        `${literal ? "Text" : "Pattern"} "${pattern}" produced no results`,
      );
      return;
    }
  } catch (err) {
    console.error(err);
    await editor.flashNotification(
      "Error running 'git' command, make sure Git is in PATH",
      "error",
    );
    return;
  }

  if (!output) {
    editor.flashNotification(
      `${literal ? "Text" : "Pattern"} "${pattern}" produced no results`,
    );
    return;
  }

  // --break separates files by an empty line
  const fileOutputs = output.split("\n\n");

  // git-grep doesn't count multiple matches, we'll search inside each line
  const innerRegex = new RegExp(
    literal ? escapeRegExp(pattern) : pattern,
    caseSensitive ? "g" : "gi",
  );

  const fileMatches = [];
  for (const fileOutput of fileOutputs) {
    const lines = fileOutput.split("\n");

    // ensure it's a markdown file and normalize to page name
    if (!lines[0].endsWith(".md")) continue;
    const page = normalizePath(lines[0].slice(0, -3));

    // Check if this file's folder should be ignored
    const folderPath = page.substring(0, page.lastIndexOf("/") + 1);
    if (await shouldIgnoreFolder(folderPath, config)) continue;

    // don't consider hits in results
    if (page === resultPageSaved) continue;
    if (page === resultPageVirtual) continue;

    const matches = [];
    for (const line of lines.slice(1)) {
      const locationMatch = line.match(/^(\d)+:(\d)+:/);
      if (!locationMatch) continue;

      // HACK: regex kept losing the first digit
      const lineNum = parseInt(line.split(":")[0]);
      const context = line.substring(
        lineNum.toString().length + line.split(":")[1].length + 2,
      );

      const innerMatches = context.matchAll(innerRegex);
      for (const innerMatch of innerMatches) {
        const columnNum = innerMatch.index + 1;
        const start = innerMatch.index;
        const end = innerMatch.index + innerMatch[0].length;
        const surrounded = [
          context.substring(0, start),
          surroundLeft,
          context.substring(start, end),
          surroundRight,
          context.substring(end),
        ].join("");
        matches.push({ lineNum, columnNum, context: surrounded });
      }
    }
    fileMatches.push({ page, matches });
  }

  fileMatches.sort((a, b) => {
    // descending sort by match count
    return -(a.matches.length - b.matches.length);
  });

  const text = `Search results for ${
    literal ? "text" : "pattern"
  } **\`${pattern}\`**${
    folder !== "." ? "\n**found inside folder:** " + folder + "\n" : ""
  }\n${
    fileMatches
      .map(
        (fm) =>
          `\n## [[${fm.page}]] (${fm.matches.length} ${
            fm.matches.length > 1 ? "matches" : "match"
          })\n` +
          fm.matches
            .map(
              (m) =>
                `* [[${fm.page}@L${m.lineNum}C${m.columnNum}|L${m.lineNum}C${m.columnNum}]]: ${m.context}`,
            )
            .join("\n"),
      )
      .join("\n")
  }
    `;
  return text;
}

// ... rest of the code remains the same ...
async function openGrep(
  pattern: string,
  literal: boolean = false,
  folder: string = ".",
) {
  const config = await system.getSpaceConfig("grep", {});

  let saveResults = false;
  if (config && config.saveResults === true) saveResults = true;

  if (saveResults) {
    const text = await grep(pattern, literal, folder);
    if (text) {
      await editor.navigate({ page: resultPageSaved });
      const textLength = (await editor.getText()).length;
      await editor.replaceRange(0, textLength, `#meta\n\n${text}`);
    }
  } else {
    await datastore.set(["grep", "arguments"], { pattern, literal, folder });
    await editor.navigate({ page: resultPageVirtual });
  }
}

export async function readFileGrepResult(
  name: string,
): Promise<{ data: Uint8Array; meta: FileMeta }> {
  let text = "Did not produce any results";
  const args = await datastore.get(["grep", "arguments"]);
  try {
    const grepText = await grep(args.pattern, args.literal, args.folder);
    if (grepText) text = grepText;
  } catch {
    text =
      `Could not call grep implementation, make sure to only open "${resultPageVirtual}" using Grep Plug commands`;
  }

  return {
    data: new TextEncoder().encode(text),
    meta: {
      name,
      contentType: "text/markdown",
      size: text.length,
      created: 0,
      lastModified: 0,
      perm: "ro",
    },
  };
}

export function writeFileGrepResult(
  name: string,
): FileMeta {
  // Never actually writing this
  return getFileMetaGrepResult(name);
}

export function getFileMetaGrepResult(name: string): FileMeta {
  return {
    name,
    contentType: "text/markdown",
    size: -1,
    created: 0,
    lastModified: 0,
    perm: "ro",
  };
}
export async function searchText() {
  const pattern = await editor.prompt("Literal text:", "");
  if (!pattern) {
    return;
  }
  await openGrep(pattern, true);
}

export async function searchRegex() {
  const pattern = await editor.prompt("Regular expression pattern:", "");
  if (!pattern) {
    return;
  }
  await openGrep(pattern, false);
}

export async function searchRegexInFolder() {
  const pageName = await editor.getCurrentPage();
  // Get the folder it's nested in, keeping the trailing /
  const folderPath = pageName.slice(0, pageName.lastIndexOf("/") + 1);
  const pattern = await editor.prompt("Regular expression pattern:", "");
  if (!pattern) {
    return;
  }
  await openGrep(pattern, false, folderPath !== "" ? folderPath : ".");
}

export async function searchTextInFolder() {
  const pageName = await editor.getCurrentPage();
  // Get the folder it's nested in, keeping the trailing /
  const folderPath = pageName.slice(0, pageName.lastIndexOf("/") + 1);
  const pattern = await editor.prompt("Literal text:", "");
  if (!pattern) {
    return;
  }
  await openGrep(pattern, false, folderPath !== "" ? folderPath : ".");
}

function normalizePath(path: string): string {
  const forward = path.replaceAll("\\", "/");
  if (forward.startsWith("./")) return forward.substring(2);
  else return forward;
}

// from: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}
