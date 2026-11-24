// Wait after each completed write; never overlap writes or replay missed ticks.
export function startCommandStream({ commands, interval, repeat, send, onProgress, onDone, onError }) {
  const steps = commands.map(command => typeof command === 'string' ? { text: command, interval } : { ...command });
  if (!steps.length || steps.some(step => typeof step.text !== 'string' || !step.text.trim() || !Number.isFinite(step.interval) || step.interval < 10 || step.interval > 86400000)) throw new Error('命令不能为空，间隔须为 10–86400000 毫秒');
  let stopped = false, timer, index = 0, count = 0;
  const stop = () => { stopped = true; clearTimeout(timer); };
  const next = async () => {
    try {
      const step = steps[index];
      await send(step.text);
      if (stopped) return;
      onProgress(++count);
      if (stopped) return;
      index++;
      if (index === steps.length) {
        if (!repeat) { stop(); onDone(); return; }
        index = 0;
      }
      timer = setTimeout(next, step.interval);
    } catch (error) { if (!stopped) { stop(); onError(error); } }
  };
  void next();
  return stop;
}
