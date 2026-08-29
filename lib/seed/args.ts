export interface SeedArgs {
  /** R21 — the export lives outside this repository, so there is no default. */
  readonly dataDir: string;
  /** Writing is opt-in: a migration is hard to undo once it has run. */
  readonly write: boolean;
}

const DATA_DIR = "--data-dir";
const CURSORS = "--cursors";
const WRITE = "--write";

/**
 * One flag parser for both cutover scripts. `--write` means the same thing in
 * each, and a second hand-rolled loop would be where the two drift.
 */
function parseFlags(
  argv: readonly string[],
  valueFlag: string,
): { value?: string; write: boolean } {
  let value: string | undefined;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === WRITE) {
      write = true;
    } else if (arg.startsWith(`${valueFlag}=`)) {
      value = arg.slice(valueFlag.length + 1);
    } else if (arg === valueFlag) {
      index += 1;
      value = argv[index];
    } else {
      // A typo must not be read as "no flag given" and quietly change what runs.
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return { ...(value === undefined ? {} : { value }), write };
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const { value, write } = parseFlags(argv, DATA_DIR);

  if (value === undefined || value === "") {
    throw new Error(`${DATA_DIR} is required: the export lives outside this repository`);
  }

  return { dataDir: value, write };
}

export interface ReseedArgs {
  /** §9.5 L832's live values. The spec names no source, so they arrive as a file. */
  readonly cursorsFile: string;
  readonly write: boolean;
}

export function parseReseedArgs(argv: readonly string[]): ReseedArgs {
  const { value, write } = parseFlags(argv, CURSORS);

  if (value === undefined || value === "") {
    throw new Error(`${CURSORS} is required: a JSON map of {sourceId: lastItemId}`);
  }

  return { cursorsFile: value, write };
}
