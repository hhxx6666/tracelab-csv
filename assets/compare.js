(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraceCompare = api;
})(globalThis, function () {
  'use strict';

  function parseCSV(source) {
    const text = source.replace(/^\uFEFF/, '').replace(/^(?:[^\S\r\n]*\r?\n)+/, '');
    if (!text.trim()) throw new Error('CSV 文件为空。');
    const header = text.match(/^(?:"(?:[^"]|"")*"|[^"\r\n])*/)?.[0] ?? '';
    const unquoted = header.replace(/"(?:[^"]|"")*"/g, '');
    const delimiter = [',', ';', '\t'].reduce((best, next) =>
      unquoted.split(next).length > unquoted.split(best).length ? next : best);
    const records = [];
    let record = [];
    let field = '';
    let inQuotes = false;
    let closedQuote = false;
    for (let i = 0; i <= text.length; i++) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          inQuotes = false;
          closedQuote = true;
        } else if (char === undefined) {
          throw new Error('CSV 中有未闭合的引号。');
        } else {
          field += char;
        }
        continue;
      }
      const endRecord = char === undefined || char === '\n' || char === '\r';
      if (endRecord || char === delimiter) {
        record.push(field.trim());
        field = '';
        closedQuote = false;
        if (endRecord) {
          if (record.length > 1 || record[0] !== '') records.push(record);
          record = [];
          if (char === '\r' && text[i + 1] === '\n') i++;
        }
        continue;
      }
      if (char === '"' && !closedQuote && !field.trim()) {
        field = '';
        inQuotes = true;
      } else if (char === '"' || (closedQuote && !/\s/.test(char))) {
        throw new Error('CSV 中的引号格式不正确。');
      } else {
        field += char;
      }
    }
    const headers = records.shift() ?? [];
    if (headers.length < 2 || headers.some(name => !name) || new Set(headers).size !== headers.length) {
      throw new Error('CSV 表头至少需要两列，列名须非空且互不重复。');
    }
    if (records.length < 2) throw new Error('CSV 至少需要两行数据。');
    const invalidRow = records.findIndex(row => row.length !== headers.length);
    if (invalidRow >= 0) throw new Error(`第 ${invalidRow + 1} 条数据的列数与表头不一致。`);
    return { headers, records };
  }

  function numeric(text) {
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return NaN;
    return Number(text);
  }

  function guessColumns(headers) {
    const time = headers.find(name => /^(time|timestamp|t)(?:\W|_|$)|^时间/i.test(name)) ?? headers[0];
    const trigger = headers.find(name => name !== time && /trigger|start|command|enable|触发|指令|启动/i.test(name)) ?? '';
    const signal = headers.find(name => name !== time && name !== trigger && /rpm|speed|value|signal|转速|信号/i.test(name))
      ?? headers.find(name => name !== time && name !== trigger) ?? headers.find(name => name !== time);
    const timeUnit = /(?:^|[\s(_\[])ms(?:$|[\s)\]])|毫秒/i.test(time) ? 'ms' : 's';
    return { time, signal, trigger, timeUnit };
  }

  function prepare(csv, columns, event) {
    const indices = [columns.time, columns.signal, columns.trigger].map(name => csv.headers.indexOf(name));
    const useTrigger = event.edge !== 'first';
    const required = useTrigger ? indices : indices.slice(0, 2);
    if (required.includes(-1) || indices[0] === indices[1]) throw new Error('请选择有效的时间列、信号列和所需的触发列。');
    const time = [];
    const values = [];
    let triggerTime;
    let found = 0;
    let previousTrigger;
    const scale = columns.timeUnit === 'ms' ? 0.001 : 1;
    for (const [index, row] of csv.records.entries()) {
      const t = numeric(row[indices[0]]) * scale;
      const y = numeric(row[indices[1]]);
      const trigger = useTrigger ? numeric(row[indices[2]]) : 0;
      if (![t, y, trigger].every(Number.isFinite)) throw new Error(`第 ${index + 1} 条数据的所选列包含空值或非数值。`);
      if (index > 0 && t <= time[index - 1]) throw new Error(`时间列必须严格递增，第 ${index + 1} 条数据重复或倒序。`);
      if (index > 0 && useTrigger && triggerTime === undefined) {
        const rising = previousTrigger < event.threshold && trigger >= event.threshold;
        const falling = previousTrigger > event.threshold && trigger <= event.threshold;
        if ((event.edge === 'rising' ? rising : falling) && ++found === event.occurrence) {
          triggerTime = time[index - 1] + (t - time[index - 1]) * (event.threshold - previousTrigger) / (trigger - previousTrigger);
        }
      }
      previousTrigger = trigger;
      time.push(t);
      values.push(y);
    }
    if (!useTrigger) triggerTime = time[0];
    if (triggerTime === undefined) throw new Error(`未找到第 ${event.occurrence} 次${event.edge === 'rising' ? '上升' : '下降'}穿越阈值 ${event.threshold}。`);
    const aligned = time.map(t => t - triggerTime);
    if (!Number.isFinite(aligned.at(-1) - aligned[0]) || aligned.some((t, i) => i > 0 && t <= aligned[i - 1])) {
      throw new Error('对齐后的时间范围超出数值精度。');
    }
    return { time: aligned, values, triggerTime };
  }

  function sampler(series) {
    let i = 0;
    return function (t) {
      const { time, values } = series;
      while (i < time.length - 2 && time[i + 1] < t) i++;
      const ratio = (t - time[i]) / (time[i + 1] - time[i]);
      return values[i] + (values[i + 1] - values[i]) * ratio;
    };
  }

  function compare(a, b, tolerance) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('容差须为大于或等于 0 的数值。');
    const start = Math.max(a.time[0], b.time[0]);
    const end = Math.min(a.time.at(-1), b.time.at(-1));
    if (!(start < end)) throw new Error('对齐后没有可比较的重叠时段。');
    const sampleA = sampler(a);
    const sampleB = sampler(b);
    const points = [];
    let ia = 0;
    let ib = 0;
    let t = start;
    while (true) {
      const va = sampleA(t);
      const vb = sampleB(t);
      const delta = vb - va;
      if (![va, vb, delta].every(Number.isFinite)) throw new Error('数据的数值范围过大，无法进行插值。');
      points.push({ t, a: va, b: vb, delta });
      if (t === end) break;
      while (ia < a.time.length && a.time[ia] <= t) ia++;
      while (ib < b.time.length && b.time[ib] <= t) ib++;
      t = Math.min(a.time[ia] ?? Infinity, b.time[ib] ?? Infinity, end);
    }
    const intervals = [];
    let peak = points[0];
    for (let i = 1; i < points.length; i++) {
      const left = points[i - 1];
      const right = points[i];
      if (Math.abs(right.delta) > Math.abs(peak.delta)) peak = right;
      if (Math.abs(left.delta) <= tolerance && Math.abs(right.delta) <= tolerance) continue;
      for (const sign of [1, -1]) {
        const lo = sign * left.delta;
        const hi = sign * right.delta;
        if (lo <= tolerance && hi <= tolerance) continue;
        const crossing = () => left.t + (right.t - left.t) * (tolerance - lo) / (hi - lo);
        const from = lo > tolerance ? left.t : crossing();
        const to = hi > tolerance ? right.t : crossing();
        const spanPeak = lo >= hi ? left : right;
        const previous = intervals.at(-1);
        if (previous && previous.sign === sign && previous.end === from) {
          previous.end = to;
          if (Math.abs(spanPeak.delta) > Math.abs(previous.peak.delta)) previous.peak = spanPeak;
        } else {
          intervals.push({ start: from, end: to, sign, peak: spanPeak });
        }
      }
    }
    intervals.sort((first, second) => first.start - second.start);
    const duration = intervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0);
    return { points, intervals, peak, start, end, duration, tolerance };
  }

  function motorCSV(isCandidate) {
    const step = isCandidate ? 0.02 : 0.025;
    const eventSample = isCandidate ? 93 : 49;
    const firstTime = isCandidate ? 0.01 : 0;
    const lines = ['time_s,start_cmd,speed_rpm'];
    const length = isCandidate ? 286 : 204;
    for (let i = 0; i < length; i++) {
      const time = firstTime + i * step;
      const t = (i - eventSample + 0.5) * step;
      const base = t > 0 ? 1500 * (1 - Math.exp(-((t / 0.34) ** 1.65))) : 0;
      const width = t < 0.88 ? 0.27 : 0.46;
      const overshoot = 167 * Math.exp(-(((t - 0.88) / width) ** 2));
      const settle = 18 * Math.exp(-(((t - 1.63) / 0.23) ** 2));
      const ripple = t > 0 ? 2.35 * Math.sin(t * 24) * Math.exp(-t * 0.42) : 0;
      const speed = Math.max(0, base + ripple + (isCandidate ? overshoot - settle : 0));
      lines.push(`${time.toFixed(3)},${Number(i >= eventSample)},${speed.toFixed(3)}`);
    }
    return lines.join('\n') + '\n';
  }

  return { parseCSV, guessColumns, prepare, compare, motorCSV };
});
