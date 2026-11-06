import { shouldAutoScreenshot } from "../shared/shot-policy.mjs";

const cases = [
  // [cmds, expected, 说明]
  [[], false, "没有动作"],
  [["click 3"], false, "只做了一次"],
  [["click 3", "click 3"], false, "做了两次"],
  [["click 3", "click 3", "click 3"], true, "连续三次相同 → 触发截图"],
  [["click 3", "click 3", "click 5"], false, "第三次不同 → 不算重复"],
  [["click 3", "click 3", "click 3", "click 5"], false, "最后一次不同 → 不触发"],
  [["scroll 2", "scroll 2", "scroll 2", "scroll 2"], true, "四次相同 → 触发"],
  [["screenshot"], false, "截图本身不触发"],
  [["screenshot", "screenshot", "screenshot"], false, "连续截图不触发"],
  [["click 3", "click 3", "screenshot"], false, "刚截过图不触发"],
  [["click 3", "click 3", "click 3", "screenshot", "click 3", "click 3"], false, "截图中断后重新计数"],
  [["input 5 \"a\"", "input 5 \"a\"", "input 5 \"a\""], true, "输入重复也触发"],
  [null, false, "cmds 为空值时不崩"],
];

let pass = 0;
for (const [cmds, expected, desc] of cases) {
  const got = shouldAutoScreenshot(cmds);
  const ok = got === expected;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${String(got).padEnd(5)} ${desc}  cmds=${JSON.stringify(cmds)}`);
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
