(function (root) {
  'use strict';

  const color = {
    ink: '#17253a', muted: '#52657f', axis: '#c9d5e3', grid: '#e9eef5',
    a: '#087f76', b: '#2865e9', red: '#c3364c', pink: '#fff0f2', band: '#edf3ff'
  };
  const bodyFont = '"Inter", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif';
  const monoFont = '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace';

  function format(value, digits = 2) {
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 10 ** -digits || abs >= 1e7)) return value.toExponential(2);
    return Number(value.toFixed(digits)).toString();
  }

  function signed(value, digits) {
    const text = format(Math.abs(value), digits);
    return value > 0 ? '+' + text : value < 0 ? '−' + text : text;
  }

  function niceStep(range, count) {
    const ideal = range / count;
    const power = 10 ** Math.floor(Math.log10(ideal));
    return ([1, 2, 2.5, 5, 10].find(step => step * power >= ideal) ?? 10) * power;
  }

  function gridValues(min, max, count) {
    const step = niceStep(max - min, count);
    const first = Math.ceil(min / step - 1e-8);
    const total = Math.min(24, Math.floor(max / step + 1e-8) - first + 1);
    return Array.from({ length: total }, (_, i) => (i + first) * step);
  }

  function draw(canvas, result, options) {
    const { width, height, ratio = 1, view = 'curves', unit = '', cursor } = options;
    const scaledWidth = Math.max(1, Math.round(width * ratio));
    const scaledHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== scaledWidth) canvas.width = scaledWidth;
    if (canvas.height !== scaledHeight) canvas.height = scaledHeight;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    if (!result || width < 185 || height < 140) return null;

    const small = width < 520;
    const isDelta = view === 'delta';
    const { points, intervals, gaps, start, end, peak, tolerance } = result;
    let low = 0;
    let high = 0;
    if (isDelta) {
      const extent = Math.max(Math.abs(peak?.delta ?? 0), tolerance, 1);
      low = -extent;
      high = extent;
    } else {
      for (const point of points) {
        low = Math.min(low, point.a, point.b);
        high = Math.max(high, point.a, point.b);
      }
    }
    const spread = high - low || 1;
    const minY = low - spread * 0.035;
    const maxY = high + spread * 0.17;
    const ticksY = gridValues(minY, maxY, 5);
    ctx.font = '11px ' + monoFont;
    const labelWidth = Math.max(28, ...ticksY.map(tick => ctx.measureText(format(tick, 4)).width));
    const left = labelWidth + (small ? 12 : 18);
    const top = 28;
    const right = width - (small ? 10 : 15);
    const bottom = height - 47;
    const x = t => left + (t - start) / (end - start) * (right - left);
    const y = value => bottom - (value - minY) / (maxY - minY) * (bottom - top);
    const timeAt = px => start + (px - left) / (right - left) * (end - start);
    const ticksX = gridValues(start, end, Math.max(3, Math.floor((right - left) / (small ? 53 : 74))));

    function line(x1, y1, x2, y2, stroke, lineWidth = 1, dash = []) {
      ctx.beginPath();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function circle(px, py, radius, fill, stroke) {
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    function trace(key, stroke, lineWidth) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const point of points) {
        if (point.breakBefore) ctx.moveTo(x(point.t), y(point[key]));
        else ctx.lineTo(x(point.t), y(point[key]));
      }
      ctx.stroke();
    }

    ctx.fillStyle = '#fafcff';
    ctx.fillRect(left, top, right - left, bottom - top);
    if (isDelta && tolerance > 0) {
      ctx.fillStyle = color.band;
      ctx.fillRect(left, y(tolerance), right - left, y(-tolerance) - y(tolerance));
    }
    ctx.fillStyle = color.pink;
    for (const span of intervals) {
      ctx.fillRect(x(span.start), top, x(span.end) - x(span.start), bottom - top);
    }
    ctx.fillStyle = '#fff0cb';
    for (const gap of gaps) ctx.fillRect(x(gap.start), top, x(gap.end) - x(gap.start), bottom - top);

    ctx.fillStyle = color.muted;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const tick of ticksY) {
      const py = y(tick);
      line(left, py, right, py, tick === 0 && isDelta ? color.axis : color.grid);
      ctx.fillText(format(tick, 4), left - 7, py);
    }
    ctx.textAlign = 'center';
    for (const tick of ticksX) {
      const px = x(tick);
      line(px, top, px, bottom, color.grid);
      ctx.fillText(format(tick, 4), Math.max(17, Math.min(width - 17, px)), bottom + 15);
    }
    line(left, top, left, bottom, color.axis);
    line(left, bottom, right, bottom, color.axis);
    ctx.font = '11px ' + bodyFont;
    ctx.textAlign = 'left';
    ctx.fillText(unit ? (isDelta ? '偏差' : '测量值') + ' (' + unit + ')' : (isDelta ? '偏差' : '测量值'), left, 13, right - left);
    ctx.textAlign = 'center';
    ctx.fillText('相对触发时间 (s)', (left + right) / 2, height - 11);

    if (start <= 0 && end >= 0) {
      const px = x(0);
      line(px, top, px, bottom, '#8495ab', 1.3, [4, 4]);
      if (px + 50 < right && !small) {
        ctx.textAlign = 'left';
        ctx.fillText('触发 · 0 s', px + 7, top + 12);
      }
    }
    if (isDelta) {
      line(left, y(tolerance), right, y(tolerance), '#bd6d7a', 1.1, [5, 4]);
      if (tolerance > 0) line(left, y(-tolerance), right, y(-tolerance), '#bd6d7a', 1.1, [5, 4]);
      trace('delta', color.b, 2.3);
    } else {
      trace('a', color.a, 2.25);
      trace('b', color.b, 2.55);
    }
    if (intervals.length) {
      ctx.save();
      ctx.beginPath();
      for (const span of intervals) {
        ctx.rect(x(span.start), top, x(span.end) - x(span.start), bottom - top);
      }
      ctx.clip();
      trace(isDelta ? 'delta' : 'b', color.red, 2.6);
      ctx.restore();

      if (!cursor) {
        const px = x(peak.t);
        const py = y(isDelta ? peak.delta : peak.b);
        circle(px, py, 4, '#fff', color.red);
        const label = (small ? '' : '峰值偏差 ') + signed(peak.delta, 1) + (unit ? ' ' + unit : '');
        ctx.font = '600 11px ' + bodyFont;
        const box = Math.min(right - left, ctx.measureText(label).width + 17);
        const boxX = Math.min(right - box, Math.max(left, px + 13));
        const boxY = py - 29 >= top ? py - 29 : Math.min(bottom - 23, py + 8);
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, box, 21, 5);
        ctx.fillStyle = '#fff6f7';
        ctx.fill();
        ctx.strokeStyle = '#f0bdc4';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillStyle = '#a7293d';
        ctx.fillText(label, boxX + box / 2, boxY + 10.5, box - 8);
      }
    }
    if (cursor) {
      const px = x(cursor.t);
      line(px, top, px, bottom, '#63758c', 1, [3, 3]);
      if (isDelta) {
        circle(px, y(cursor.delta), 4, 'white', color.b);
      } else {
        circle(px, y(cursor.a), 4, 'white', color.a);
        circle(px, y(cursor.b), 4, 'white', color.b);
      }
    }
    return { left, right, top, bottom, x, timeAt };
  }

  root.TraceChart = { draw, format, signed };
})(globalThis);
