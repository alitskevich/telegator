export interface SeedArgs {
  /** R21 — the export lives outside this repository, so there is no default. */
  readonly dataDir: string;
  /** Writing is opt-in: a migration is hard to undo once it has run. */
  readonly write: boolean;
}

const DATA_DIR = "--data-dir";
const WRITE = "--write";

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  let dataDir: string | undefined;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";

    if (arg === WRITE) {
      write = true;
    } else if (arg.startsWith(`${DATA_DIR}=`)) {
      dataDir = arg.slice(DATA_DIR.length + 1);
    } else if (arg === DATA_DIR) {
      index += 1;
      dataDir = argv[index];
    } else {
      // A typo must not be read as "no flag given" and quietly change what runs.
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (dataDir === undefined || dataDir === "") {
    throw new Error(`${DATA_DIR} is required: the export lives outside this repository`);
  }

  return { dataDir, write };
}
