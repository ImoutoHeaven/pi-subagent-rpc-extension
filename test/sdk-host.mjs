// Stands in for an SDK host such as pi-web: runs the Pi CLI entry given as the first argument in this process,
// so process.argv[1] is this file rather than Pi's CLI.
import { pathToFileURL } from "node:url";

const [entry] = process.argv.splice(2, 1);
await import(pathToFileURL(entry).href);
