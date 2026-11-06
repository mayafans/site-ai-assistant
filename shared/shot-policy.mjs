/**
 * 重复操作检测：连续 3 次相同动作时，自动截一张图交给模型（对应 KiKi 的
 * “重复操作提醒 + 附当前页面截图”行为）。
 * 抽成独立模块，方便两个服务端共用并做单元测试。
 */
export function shouldAutoScreenshot(cmds) {
  const list = Array.isArray(cmds) ? cmds : [];
  if (list.length < 3) return false;
  const last = list[list.length - 1];
  if (!last || last === "screenshot") return false;
  return list.slice(-3).every((c) => c === last);
}
