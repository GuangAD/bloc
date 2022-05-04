import fs from "fs";

export function scanDir(dir: fs.PathLike) {
  return fs
    .readdirSync(dir, "utf-8")
    .filter((element) => !element.includes("index"))
    .map((element) => element.split(".")[0]);
}
