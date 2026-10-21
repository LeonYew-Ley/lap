// One queue for all thumbnail batches in the main grid. Running IPC requests
// finish normally; only queued work can be discarded or reprioritized.
export function createThumbnailScheduler({ loadBatch, priority, concurrency = 4, batchSize = 4 }) {
  const tasks = new Map();
  let active = 0;
  let scheduled = false;
  let disposed = false;

  // Deduplication shares the read, but each caller keeps its own retention rule.
  function taskPriority(task) {
    let best = null;
    for (const payload of task.demands) {
      const value = priority(payload);
      if (value == null) {
        task.demands.delete(payload);
      } else if (best == null || value < best) {
        best = value;
        task.payload = payload;
      }
    }
    return best;
  }

  function settle(task, result, error) {
    tasks.delete(task.key);
    if (error) task.reject(error);
    else task.resolve(result);
  }

  function refresh() {
    for (const task of tasks.values()) {
      if (!task.running && taskPriority(task) == null) settle(task);
    }
    if (!scheduled && !disposed) {
      scheduled = true;
      queueMicrotask(pump);
    }
  }

  function pump() {
    scheduled = false;
    if (disposed) return;
    for (const task of tasks.values()) {
      if (!task.running && taskPriority(task) == null) settle(task);
    }
    while (active < concurrency) {
      const queued = [...tasks.values()]
        .filter(task => !task.running && taskPriority(task) != null)
        .sort((a, b) => taskPriority(a) - taskPriority(b));
      if (!queued.length) break;
      // A batch must use one library/view context, thumbnail size and cache policy.
      const batch = queued.filter(task => task.group === queued[0].group).slice(0, batchSize);
      for (const task of batch) task.running = true;
      active++;
      Promise.resolve().then(() => {
        // Context or lifecycle can change after reserving a slot but before IPC.
        const live = batch.filter(task => !disposed && taskPriority(task) != null);
        for (const task of batch) {
          if (!live.includes(task)) settle(task);
        }
        if (!live.length) return;
        let result;
        try {
          result = loadBatch(live.map(task => task.payload));
        } catch (error) {
          live.forEach(task => settle(task, undefined, error));
          return;
        }
        return Promise.resolve(result)
          .then(results => live.forEach((task, index) => settle(task, results?.[index])),
            error => live.forEach(task => settle(task, undefined, error)));
      })
        .finally(() => { active--; refresh(); });
    }
  }

  return {
    request(key, group, payload) {
      if (disposed || priority(payload) == null) return Promise.resolve(undefined);
      const existing = tasks.get(key);
      if (existing) {
        existing.demands.add(payload);
        return existing.promise;
      }
      const task = { key, group, payload, demands: new Set([payload]), running: false };
      task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
      tasks.set(key, task);
      refresh();
      return task.promise;
    },
    refresh,
    dispose() {
      disposed = true;
      for (const task of tasks.values()) {
        if (!task.running) settle(task);
      }
    },
  };
}
