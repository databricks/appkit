import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

fs.mkdirSync("tmp", { recursive: true });

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));

delete pkg.dependencies.shared;

pkg.exports = pkg.publishConfig.exports;
delete pkg.publishConfig.exports;

fs.writeFileSync("tmp/package.json", JSON.stringify(pkg, null, 2));

fs.cpSync("dist", "tmp/dist", { recursive: true });

fs.copyFileSync(path.join(__dirname, "../llms.txt"), "tmp/llms.txt");
fs.copyFileSync(path.join(__dirname, "../README.md"), "tmp/README.md");
fs.copyFileSync(path.join(__dirname, "../LICENSE"), "tmp/LICENSE");
