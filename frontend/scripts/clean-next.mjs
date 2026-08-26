import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const nextDirs = [".next", ".next-dev"].map((directory) => resolve(process.cwd(), directory));

let removedDirectory = false;

for (const nextDir of nextDirs) {
  if (existsSync(nextDir)) {
    rmSync(nextDir, { recursive: true, force: true });
    removedDirectory = true;
  }
}

console.log(removedDirectory ? "Removed stale Next.js caches." : "No Next.js cache found.");
