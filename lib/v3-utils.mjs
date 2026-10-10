// 独立的任务参数校验和时间计算，不依赖模型与数据库。
export function normalizeSchedule(input, now = Date.now()) {
  const text = String(input?.text ?? "").trim();
  const delay = Number(input?.minutesFromNow);
  const repeat = Number(input?.everyMinutes ?? 0);
  if (!text || text.length > 1000) throw new Error("任务内容必须是 1～1000 字");
  if (!Number.isFinite(delay) || delay < 0.25 || delay > 525600) throw new Error("首次执行时间必须在 0.25～525600 分钟内");
  if (!Number.isFinite(repeat) || repeat < 0 || (repeat > 0 && (repeat < 1 || repeat > 525600))) {
    throw new Error("重复间隔须为 0 或 1～525600 分钟");
  }
  return { text, at: now + Math.round(delay * 60000), everyMinutes: repeat };
}

export function nextOccurrence(previousAt, everyMinutes, now = Date.now()) {
  if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return null;
  const interval = Math.round(everyMinutes * 60000);
  return previousAt + Math.max(1, Math.floor((now - previousAt) / interval) + 1) * interval;
}

export function scheduleMatches(item, taskInput) {
  return item?.status === "active" && item.nextAt === taskInput.at && item.revision === taskInput.revision;
}
