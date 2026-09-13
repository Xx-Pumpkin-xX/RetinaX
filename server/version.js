/* -----------------------------------------------------------------------------
 * What build is this?
 *
 * The API runs on prts-0, which is deployed by unpacking a tar. There is no git
 * checkout there, so "is prts-0 running the code I just wrote?" had no answer
 * except guessing from behaviour — which is how a fix gets shipped twice and a
 * bug gets chased in code that was never deployed.
 *
 * tools/build-server-tar.sh stamps a BUILD file into the tar at pack time. This
 * module reads it and /api/health reports it. If the BUILD file is missing the
 * server still starts; it just says so, which is itself useful information (it
 * means somebody copied files by hand).
 *
 * Precedence: environment  ->  BUILD file  ->  package.json  ->  unknown.
 * The environment wins so a one-off run can label itself without repacking.
 * -------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readKeyValueFile(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

const build = readKeyValueFile(path.join(HERE, "BUILD"));

export const VERSION = {
  version: process.env.RX_VERSION || build.VERSION || readPackageVersion() || "unknown",
  commit: process.env.RX_COMMIT || build.COMMIT || "unknown",
  branch: process.env.RX_BRANCH || build.BRANCH || "unknown",
  builtAt: process.env.RX_BUILT_AT || build.BUILT_AT || "unknown",
  // "tar" when build-server-tar.sh packed it, "source" when it is a git
  // checkout or a hand copy. Tells you which deploy path produced this box.
  packedBy: build.PACKED_BY || (Object.keys(build).length ? "tar" : "source"),
};

/** One line for the boot log: "1.0.0 (3807b12, main) built 2026-09-13T04:11:02Z" */
export function versionLine() {
  const { version, commit, branch, builtAt } = VERSION;
  return `${version} (${commit}, ${branch}) built ${builtAt}`;
}
