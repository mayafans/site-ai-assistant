/**
 * 构建：src/sdk.js → public/widget.js
 *
 * 前端只有一个源文件 src/sdk.js（末尾内联了 html2canvas-pro 的 vendor 段），
 * 构建就是拷贝，避免两份 UI/动作代码漂移。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, "src/sdk.js");
const out = path.resolve(__dirname, "public/widget.js");

if (!fs.existsSync(src)) {
  console.error("找不到源文件:", src);
  process.exit(1);
}
const code = fs.readFileSync(src, "utf8");
fs.writeFileSync(out, code);
console.log("built", path.relative(__dirname, out), (code.length / 1024).toFixed(1) + "KB");
