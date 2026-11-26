(function () {
  'use strict';

  const { parseCSV, guessColumns, prepare, compare, motorCSV } = window.TraceCompare;
  const { draw, format, signed } = window.TraceChart;
  const get = id => document.getElementById(id);
  const canvas = get('chart');
  const stage = get('chart-stage');
  const tip = get('chart-tip');
  const maxFileSize = 10 * 1024 * 1024;
  const model = {
    sources: { a: null, b: null }, demo: false, view: 'curves', result: null,
    geometry: null, cursor: -1, event: null, anchors: null, unitEdited: false
  };
  let importQueue = Promise.resolve();
  let importEpoch = 0;
  let frame;

  const slotName = side => side === 'a' ? '基准 A' : '新版 B';
  const unit = () => get('signal-unit').value.trim();
  const unitSuffix = () => unit() ? ' ' + unit() : '';
  const announce = message => { get('status').textContent = message; };
  const selectOption = (value, title) => new Option(title, value);
  const seconds = number => format(number, 3) + ' s';

  function setError(message = '') {
    const error = get('error');
    error.textContent = message;
    error.hidden = !message;
  }

  function populateMapping(side) {
    const source = model.sources[side];
    const fieldset = get('mapping-' + side);
    const legend = fieldset.querySelector('legend');
    fieldset.replaceChildren(legend);
    fieldset.disabled = !source;
    const headers = source?.csv.headers ?? [];
    const fields = [
      ['time', '时间列', headers.map(header => selectOption(header, header))],
      ['signal', '信号列', headers.map(header => selectOption(header, header))],
      ['trigger', '触发列', [selectOption('', '选择触发列'), ...headers.map(header => selectOption(header, header))]],
      ['timeUnit', '时间单位', [selectOption('s', '秒 (s)'), selectOption('ms', '毫秒 (ms)')]]
    ];
    for (const [key, title, options] of fields) {
      const label = document.createElement('label');
      label.className = 'field';
      const heading = document.createElement('span');
      heading.textContent = title;
      const select = document.createElement('select');
      select.id = side + '-' + key;
      select.replaceChildren(...options);
      select.value = source?.columns[key] ?? '';
      select.addEventListener('change', () => {
        source.columns[key] = select.value;
        recalculate();
      });
      label.append(heading, select);
      fieldset.append(label);
    }
  }

  function showFiles() {
    for (const side of ['a', 'b']) {
      const source = model.sources[side];
      const name = get('name-' + side);
      name.textContent = source?.name ?? '导入' + slotName(side) + ' CSV';
      name.title = source?.name ?? '';
      get('meta-' + side).textContent = source
        ? source.csv.records.length.toLocaleString('zh-CN') + ' 个采样点 · ' + (model.demo ? '示例数据' : '本地文件')
        : '拖入文件或点击选择';
      populateMapping(side);
    }
  }

  function eventSettings() {
    const edge = get('edge').value;
    const threshold = get('threshold').valueAsNumber;
    const occurrence = get('occurrence').valueAsNumber;
    if (edge !== 'first' && (!Number.isFinite(threshold) || !Number.isSafeInteger(occurrence) || occurrence < 1)) {
      throw new Error('请输入有效的触发阈值，并将触发次数设为正整数。');
    }
    return { edge, threshold, occurrence };
  }

  function eventLabel(event) {
    if (event.edge === 'first') return '首个采样点';
    return '第 ' + event.occurrence + ' 次' + (event.edge === 'rising' ? '上升沿' : '下降沿');
  }

  function recalculate() {
    setError();
    const firstSample = get('edge').value === 'first';
    get('trigger-parameters').hidden = firstSample;
    for (const side of ['a', 'b']) get(side + '-trigger').disabled = firstSample;
    model.result = null;
    model.anchors = null;
    model.cursor = -1;
    model.event = null;
    const { a, b } = model.sources;
    if (!model.unitEdited) {
      const rpm = [a, b].every(source => /rpm/i.test(source?.columns.signal ?? ''));
      get('signal-unit').value = rpm ? 'rpm' : '';
    }
    if (a && b) {
      try {
        const event = eventSettings();
        model.event = event;
        const series = {};
        for (const side of ['a', 'b']) {
          const source = model.sources[side];
          try {
            series[side] = prepare(source.csv, source.columns, event);
          } catch (error) {
            throw new Error(slotName(side) + ' · ' + error.message);
          }
        }
        const tolerance = get('tolerance').valueAsNumber;
        model.result = compare(series.a, series.b, tolerance);
        model.anchors = { a: series.a.triggerTime, b: series.b.triggerTime };
      } catch (error) {
        setError(error.message);
      }
    }
    render();
  }

  function loadDemo() {
    importEpoch++;
    for (const side of ['a', 'b']) {
      const csv = parseCSV(motorCSV(side === 'b'));
      model.sources[side] = {
        name: side === 'a' ? 'motor-baseline.csv' : 'motor-v2.csv',
        csv,
        columns: guessColumns(csv.headers)
      };
    }
    model.demo = true;
    model.view = 'curves';
    model.unitEdited = false;
    get('edge').value = 'rising';
    get('threshold').value = '0.5';
    get('occurrence').value = '1';
    get('tolerance').value = '50';
    get('advanced').open = false;
    showFiles();
    recalculate();
    announce('已载入电机启动样例。');
  }

  function intervalCells(interval) {
    return [
      seconds(interval.start),
      seconds(interval.end),
      seconds(interval.end - interval.start),
      signed(interval.peak.delta, 2) + unitSuffix(),
      interval.sign > 0 ? '新版 B 高于基准' : '新版 B 低于基准'
    ];
  }

  function showIntervals(result) {
    const tbody = get('intervals');
    const rows = document.createDocumentFragment();
    if (!result?.intervals.length) {
      const row = document.createElement('tr');
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.textContent = result ? '重叠时段内无超差。' : '等待有效的对比数据。';
      rows.append(row);
    } else {
      for (const interval of result.intervals) {
        const row = document.createElement('tr');
        intervalCells(interval).forEach((value, index) => {
          const cell = row.insertCell();
          cell.textContent = value;
          if (index === 3) cell.className = 'peak';
        });
        rows.append(row);
      }
    }
    tbody.replaceChildren(rows);
  }

  function render() {
    const result = model.result;
    const count = result?.intervals.length;
    const stat = get('result-stat');
    stat.textContent = result ? (count ? '发现超差' : '容差内') : '待对比';
    stat.className = 'metric-value result' + (result ? (count ? ' bad' : ' good') : '');
    const icon = get('result-icon');
    icon.setAttribute('href', result && !count ? '#i-check' : '#i-alert');
    icon.closest('.metric-icon').classList.toggle('green', Boolean(result && !count));
    get('result-count').textContent = result ? count + ' 个区间' : '';
    get('peak-stat').textContent = result ? signed(result.peak.delta, 1) : '—';
    get('duration-stat').textContent = result ? format(result.duration, 3) : '—';
    const tolerance = get('tolerance').valueAsNumber;
    get('tolerance-stat').textContent = Number.isFinite(tolerance) && tolerance >= 0 ? '±' + format(tolerance, 3) : '—';
    get('tolerance-unit').textContent = unit();
    document.querySelectorAll('.signal-unit').forEach(element => { element.textContent = unit(); });
    get('interval-count').textContent = result ? count : '—';
    get('chart-title').textContent = model.demo ? '电机启动响应' : '实验信号对比';
    get('demo-badge').hidden = !model.demo;
    get('chart-description').textContent = model.demo && model.event?.edge === 'rising' && model.event.occurrence === 1
      ? '对齐到启动指令的上升沿 · t = 0'
      : model.event ? '对齐到' + eventLabel(model.event) + ' · t = 0' : '相对触发时间';
    get('anchor-details').hidden = !model.anchors;
    if (model.anchors) {
      for (const side of ['a', 'b']) get('anchor-' + side).textContent = format(model.anchors[side], 4) + ' s';
    }
    get('export').disabled = !result;
    get('chart-empty').hidden = Boolean(result);
    canvas.tabIndex = result ? 0 : -1;
    showIntervals(result);
    showView();
  }

  function showView() {
    const deltaView = model.view === 'delta';
    get('curves-tab').setAttribute('aria-pressed', String(!deltaView));
    get('delta-tab').setAttribute('aria-pressed', String(deltaView));
    canvas.setAttribute('aria-label', (deltaView ? '偏差曲线' : '对齐信号曲线') + '。按左右方向键逐点查看。');
    const legend = get('legend');
    const entries = deltaView
      ? [['legend-line candidate', '新版 B − 基准 A'], ['legend-line limit', '容差边界']]
      : [['legend-line baseline', '基准 A'], ['legend-line candidate', '新版 B']];
    entries.push(['legend-area', '超差区间'], ['legend-line trigger', '触发事件']);
    legend.replaceChildren(...entries.map(([className, label]) => {
      const entry = document.createElement('span');
      const marker = document.createElement('i');
      marker.className = className;
      entry.append(marker, label);
      return entry;
    }));
    scheduleDraw();
  }

  function scheduleDraw() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      const point = model.result?.points[model.cursor];
      model.geometry = draw(canvas, model.result, {
        width, height, ratio: Math.min(window.devicePixelRatio || 1, 2), view: model.view, unit: unit(), cursor: point
      });
      tip.hidden = !point || !model.geometry;
      if (!tip.hidden) {
        tip.textContent = 't  ' + seconds(point.t) + '\nA  ' + format(point.a, 2) + unitSuffix() +
          '\nB  ' + format(point.b, 2) + unitSuffix() + '\nΔ  ' + signed(point.delta, 2) + unitSuffix();
        const px = model.geometry.x(point.t);
        const maxLeft = width - tip.offsetWidth - 2;
        tip.style.left = Math.max(2, Math.min(maxLeft, px + 13)) + 'px';
        tip.style.top = model.geometry.top + 26 + 'px';
      }
    });
  }

  function setCursor(index, keyboard = false) {
    if (index === model.cursor) return;
    model.cursor = index;
    scheduleDraw();
    if (keyboard && index >= 0) {
      const point = model.result.points[index];
      announce(seconds(point.t) + '，基准 ' + format(point.a, 2) + '，新版 ' + format(point.b, 2) +
        '，偏差 ' + signed(point.delta, 2) + unitSuffix());
    }
  }

  function closestPoint(points, time) {
    let left = 0;
    let right = points.length - 1;
    while (right - left > 1) {
      const middle = Math.floor((left + right) / 2);
      if (points[middle].t < time) left = middle;
      else right = middle;
    }
    return time - points[left].t < points[right].t - time ? left : right;
  }

  async function openFile(file) {
    if (file.size > maxFileSize) throw new Error(file.name + ' 超过单个文件 10 MiB 的大小上限。');
    try {
      const csv = parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      return { name: file.name, csv, columns: guessColumns(csv.headers) };
    } catch (error) {
      if (error instanceof TypeError) throw new Error(file.name + ' 无法读取为 UTF-8 文本。');
      throw new Error(file.name + ' · ' + error.message);
    }
  }

  function queueImport(files, side) {
    if (!files.length) return;
    if (files.length > 2) {
      setError('每次最多导入两份 CSV。');
      return;
    }
    const epoch = importEpoch;
    importQueue = importQueue.then(async () => {
      if (epoch !== importEpoch) return;
      try {
        const sources = await Promise.all(files.map(openFile));
        if (epoch !== importEpoch) return;
        if (model.demo) {
          model.demo = false;
          model.sources = { a: null, b: null };
          model.view = 'curves';
          model.unitEdited = false;
          get('tolerance').value = '';
        }
        if (sources.length === 2) {
          [model.sources.a, model.sources.b] = sources;
        } else {
          const slot = side ?? (model.sources.a && !model.sources.b ? 'b' : 'a');
          model.sources[slot] = sources[0];
        }
        const { a, b } = model.sources;
        const needsTrigger = get('edge').value !== 'first' && [a, b].some(source => source && !source.columns.trigger);
        if (needsTrigger) get('advanced').open = true;
        showFiles();
        recalculate();
        announce(sources.length === 2 ? '已导入两份 CSV。' : '已导入 ' + sources[0].name + '。');
      } catch (error) {
        if (epoch === importEpoch) setError(error.message);
      }
    });
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function exportReport() {
    const result = model.result;
    if (!result) return;
    const created = new Date();
    const title = model.demo ? '电机启动响应对比报告' : '实验数据对比报告';
    const html = escapeHTML;
    const rows = result.intervals.map(interval =>
      '<tr>' + intervalCells(interval).map(value => '<td>' + html(value) + '</td>').join('') + '</tr>'
    ).join('') || '<tr><td colspan="5">重叠时段内无超差。</td></tr>';
    const charts = ['curves', 'delta'].map(view => {
      const image = document.createElement('canvas');
      const label = view === 'curves' ? '对齐曲线' : '偏差曲线';
      draw(image, result, { width: 1000, height: 360, ratio: 2, view, unit: unit() });
      return '<section><h2>' + label + '</h2><img alt="' + label + '，红色区域表示超差" src="' + image.toDataURL() + '">' +
        '<p class="legend">' + (view === 'curves' ? '绿线 基准 A · 蓝线 新版 B' : '蓝线 新版 B − 基准 A · 红色虚线 容差边界') +
        ' · 红色区域 超差 · 灰色虚线 触发事件</p></section>';
    }).join('');
    const inputs = ['a', 'b'].map(side => {
      const { name, csv, columns } = model.sources[side];
      return '<dt>' + slotName(side) + '</dt><dd>' + html(name) + ' · ' + csv.records.length + ' 个采样点<br>' +
        '时间列 ' + html(columns.time) + ' (' + columns.timeUnit + ') · 信号列 ' + html(columns.signal) +
        (model.event.edge === 'first' ? '' : ' · 触发列 ' + html(columns.trigger)) +
        ' · 原始触发时刻 ' + format(model.anchors[side], 4) + ' s</dd>';
    }).join('');
    const event = eventLabel(model.event) +
      (model.event.edge === 'first' ? '' : ' · 阈值 ' + format(model.event.threshold, 4));
    const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(created);
    const markup = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
*{box-sizing:border-box}body{background:#f5f7fb;color:#17253a;font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px}
main{max-width:1050px;margin:auto}header{padding:8px 0 16px}h1,h2,p{margin:0}h1{font-size:29px}h2{font-size:17px}
.brand{font-weight:750;color:#245cde}header p:last-child,.legend{color:#52657f}.lede{margin-top:8px}
section,.metrics>div{background:white;border:1px solid #e1e8f0;border-radius:10px;padding:15px;margin:0 0 12px}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:10px}.metrics span{display:block;color:#52657f}
.metrics strong{font-size:19px}.bad{color:#ae2e40}.good{color:#087248}img{display:block;width:100%;height:auto}
.table-container{overflow-x:auto}table{width:100%;border-collapse:collapse;margin-top:9px;text-align:left}
th,td{padding:8px;white-space:nowrap;border-bottom:1px solid #e8edf4}th{background:#f5f7fb}dl{margin:8px 0}dt{font-weight:700}dd{margin:0 0 8px;overflow-wrap:anywhere}
@media print{body{background:white;padding:0}section,.metrics>div{break-inside:avoid}}
</style>
<main><header><p class="brand">TraceLab</p><h1>${html(title)}</h1>
<p class="lede"><time datetime="${created.toISOString()}">${date} (UTC+8)</time>${model.demo ? ' · 内置模拟样例' : ''}</p></header>
<div class="metrics">
<div><span>对比结论</span><strong class="${result.intervals.length ? 'bad' : 'good'}">${result.intervals.length ? '发现超差' : '容差内'}</strong></div>
<div><span>最大偏差</span><strong>${html(signed(result.peak.delta, 2) + unitSuffix())}</strong></div>
<div><span>累计超差</span><strong>${seconds(result.duration)}</strong></div>
<div><span>允许偏差</span><strong>${html('±' + format(result.tolerance, 4) + unitSuffix())}</strong></div>
</div>
${charts}
<section><h2>超差区间（${result.intervals.length}）</h2><div class="table-container"><table>
<thead><tr><th>开始</th><th>结束</th><th>持续时间</th><th>区间峰值偏差</th><th>偏差方向</th></tr></thead>
<tbody>${rows}</tbody></table></div></section>
<section><h2>对比参数</h2><dl>${inputs}
<dt>触发事件</dt><dd>${html(event)}</dd><dt>比较时段</dt><dd>${seconds(result.start)} 至 ${seconds(result.end)}（相对于触发事件）</dd></dl>
<p>偏差 = 新版 B − 基准 A。时间轴对齐到各自的触发事件。两条信号在重叠时段内进行线性插值，绝对偏差严格大于容差的区间标红。</p></section></main></html>`;
    const url = URL.createObjectURL(new Blob([markup], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = model.demo ? 'tracelab-motor-report.html' : 'tracelab-report-' + created.toISOString().slice(0, 10) + '.html';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce('已导出独立 HTML 报告。');
  }

  for (const side of ['a', 'b']) {
    const button = get('drop-' + side);
    const input = get('input-' + side);
    button.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      queueImport(Array.from(input.files), side);
      input.value = '';
    });
    button.addEventListener('dragover', event => {
      if (event.dataTransfer.types.includes('Files')) button.classList.add('drag-over');
    });
    button.addEventListener('dragleave', event => {
      if (!button.contains(event.relatedTarget)) button.classList.remove('drag-over');
    });
  }
  document.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('dragging-files');
  });
  document.addEventListener('dragleave', event => {
    if (!event.relatedTarget) document.body.classList.remove('dragging-files');
  });
  document.addEventListener('drop', event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    document.body.classList.remove('dragging-files');
    const zone = event.target.closest('.file-drop');
    for (const button of document.querySelectorAll('.file-drop')) button.classList.remove('drag-over');
    queueImport(Array.from(event.dataTransfer.files), zone?.id.slice(-1));
  });
  canvas.addEventListener('pointermove', event => {
    const geom = model.geometry;
    if (!geom || !model.result) return;
    if (event.offsetX < geom.left || event.offsetX > geom.right || event.offsetY < geom.top || event.offsetY > geom.bottom) {
      setCursor(-1);
      return;
    }
    setCursor(closestPoint(model.result.points, geom.timeAt(event.offsetX)));
  });
  canvas.addEventListener('pointerleave', () => setCursor(-1));
  canvas.addEventListener('blur', () => setCursor(-1));
  canvas.addEventListener('keydown', event => {
    if (!model.result || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = model.result.points.length - 1;
    let target = model.cursor + (event.key === 'ArrowLeft' ? -1 : 1);
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = last;
    setCursor(Math.max(0, Math.min(last, target)), true);
  });
  for (const id of ['edge', 'threshold', 'occurrence', 'tolerance']) get(id).addEventListener('change', recalculate);
  get('signal-unit').addEventListener('input', () => { model.unitEdited = true; render(); });
  get('curves-tab').addEventListener('click', () => { model.view = 'curves'; showView(); });
  get('delta-tab').addEventListener('click', () => { model.view = 'delta'; showView(); });
  get('load-demo').addEventListener('click', loadDemo);
  get('export').addEventListener('click', exportReport);
  get('open-guide').addEventListener('click', () => get('guide').showModal());
  new ResizeObserver(scheduleDraw).observe(stage);
  loadDemo();
})();
